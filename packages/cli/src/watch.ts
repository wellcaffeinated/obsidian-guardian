import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import {
  parseChangesSignal,
  type ReviewEngine,
  type SnapshotStatus,
} from '@obsidian-guardian/engine'
import chokidar from 'chokidar'
import type { ResolvedConfig } from './config'

/** Options controlling the watch loop. */
export interface WatchOptions {
  /** Use polling instead of native fs events (more reliable over bind-mounts). */
  poll?: boolean
  /** Quiet period (ms) after the last change before acting. Default 300. */
  debounceMs?: number
  /** Grace (ms) a superseded signal file is kept before deletion. Default 30000. */
  graceMs?: number
  /** Called after every snapshot write with the freshly-computed status. */
  onRefresh?: (status: SnapshotStatus) => void
  /** Called when an `accepted` signal was processed (applied = baseline moved). */
  onBless?: (snapshot: string, applied: boolean) => void
  /** Called once the watcher is up and the initial pass has run. */
  onReady?: () => void
}

/** A running watcher; call {@link WatchHandle.close} to stop it. */
export interface WatchHandle {
  close: () => Promise<void>
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Churny paths the watcher never reacts to (the review folder is handled separately). */
function makeIgnorer(): (path: string) => boolean {
  const seg = (p: string, name: string): boolean =>
    p.includes(`${sep}${name}${sep}`) || p.endsWith(`${sep}${name}`)
  return (path: string): boolean =>
    seg(path, '.git') ||
    seg(path, 'node_modules') ||
    seg(path, '.obsidian') ||
    seg(path, '.trash') ||
    path.endsWith(`${sep}.DS_Store`)
}

/**
 * Watch the vault and maintain the rotating, immutable signal files in the
 * review folder. On every vault change it writes a new snapshot file (an
 * immutable per-snapshot `changes-<replica>-<snap>.md`) and supersedes the prior
 * one after a grace window. It also reacts to *external* edits of its own
 * replica's files — an `accepted: true` toggle synced back from another device —
 * by blessing exactly that pinned snapshot (idempotent, order-independent via the
 * engine's seq high-water mark). Writes are distinguished from external edits by
 * a content hash, so the watcher never reacts to its own output. Resolves once
 * the watcher is ready.
 */
export async function runWatch(
  engine: ReviewEngine,
  config: ResolvedConfig,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = options.debounceMs ?? 300
  const graceMs = options.graceMs ?? 30_000
  const reviewAbs = join(config.vaultPath, config.reviewFolder)
  const prefix = engine.signalPrefix

  // Serialize all engine ops onto a single chain (errors don't break the chain).
  let chain: Promise<void> = Promise.resolve()
  const serialize = (fn: () => Promise<void>): Promise<void> => {
    const run = chain.then(fn)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // Hash of the bytes we last wrote to each signal path, so an event that reads
  // back those exact bytes is recognised as our own write and ignored.
  const lastWritten = new Map<string, string>()
  let current: string | null = null
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false

  const isOurs = (name: string): boolean =>
    name.startsWith(prefix) && name.endsWith('.md')

  const listSignalFiles = async (): Promise<string[]> => {
    try {
      return (await readdir(reviewAbs)).filter(isOurs)
    } catch {
      return []
    }
  }

  const scheduleSupersede = (name: string): void => {
    if (closed) return
    setTimeout(() => {
      if (name === current) return
      const p = join(reviewAbs, name)
      rm(p, { force: true })
        .then(() => lastWritten.delete(p))
        .catch(() => undefined)
    }, graceMs)
  }

  // Write the current snapshot file and supersede the previous one.
  const reconcileCurrent = async (): Promise<void> => {
    const { status, fileName, content } = await engine.writeSnapshot()
    lastWritten.set(join(reviewAbs, fileName), sha(content))
    if (current && current !== fileName) scheduleSupersede(current)
    current = fileName
    options.onRefresh?.(status)
  }

  // Read + parse a signal file, returning null for our own writes / missing /
  // unparseable files.
  const readSignal = async (
    name: string,
  ): Promise<ReturnType<typeof parseChangesSignal> | null> => {
    const p = join(reviewAbs, name)
    let content: string
    try {
      content = await readFile(p, 'utf8')
    } catch {
      return null
    }
    if (sha(content) === lastWritten.get(p)) return null // our own write
    return parseChangesSignal(content)
  }

  const handleSignal = async (name: string): Promise<void> => {
    const sig = await readSignal(name)
    if (!sig?.accepted || sig.snapshot === null || sig.seq === null) return
    const applied = await engine.blessSnapshot(sig.snapshot, sig.seq)
    if (applied) await reconcileCurrent()
    scheduleSupersede(name) // consume the toggled file either way
    options.onBless?.(sig.snapshot, applied)
  }

  // Initial pass: apply any signal pending from before we started, write the
  // current snapshot, then clean up stale files.
  await serialize(async () => {
    for (const name of await listSignalFiles()) {
      const sig = await readSignal(name)
      if (sig?.accepted && sig.snapshot !== null && sig.seq !== null) {
        await engine.blessSnapshot(sig.snapshot, sig.seq)
      }
    }
    await reconcileCurrent()
    for (const name of await listSignalFiles()) {
      if (name !== current) scheduleSupersede(name)
    }
  })

  const debounce = (key: string, fn: () => void): void => {
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        fn()
      }, debounceMs),
    )
  }

  const watcher = chokidar.watch(config.vaultPath, {
    ignoreInitial: true,
    usePolling: options.poll ?? false,
    ignored: makeIgnorer(),
  })
  watcher.on('all', (event, path) => {
    if (path === reviewAbs) return
    if (path.startsWith(`${reviewAbs}${sep}`)) {
      const name = basename(path)
      if (!isOurs(name)) return
      if (event === 'unlink') {
        lastWritten.delete(path)
        return
      }
      debounce(`signal:${name}`, () => void serialize(() => handleSignal(name)))
      return
    }
    debounce('snapshot', () => void serialize(reconcileCurrent))
  })

  await new Promise<void>((resolveReady) => {
    watcher.once('ready', () => resolveReady())
  })
  options.onReady?.()

  return {
    close: async (): Promise<void> => {
      closed = true
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      await watcher.close()
    },
  }
}
