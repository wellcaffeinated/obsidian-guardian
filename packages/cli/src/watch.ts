import { sep } from 'node:path'
import type { ReviewEngine, Status } from '@obsidian-guardian/engine'
import chokidar from 'chokidar'
import type { ResolvedConfig } from './config'

/** Options controlling the watch loop. */
export interface WatchOptions {
  /** Use polling instead of native fs events (more reliable over bind-mounts). */
  poll?: boolean
  /** Quiet period (ms) after the last change before refreshing. Default 300. */
  debounceMs?: number
  /** Called after every refresh with the freshly-computed status. */
  onRefresh?: (status: Status) => void
  /** Called once the watcher is up and the initial refresh has run. */
  onReady?: () => void
}

/** A running watcher; call {@link WatchHandle.close} to stop it. */
export interface WatchHandle {
  close: () => Promise<void>
}

/** True for paths the watcher should never react to (review output, git, deps). */
function makeIgnorer(
  vaultPath: string,
  reviewFolder: string,
): (path: string) => boolean {
  const reviewAbs = `${vaultPath}${sep}${reviewFolder}`
  return (path: string): boolean => {
    if (path === reviewAbs || path.startsWith(`${reviewAbs}${sep}`)) return true
    return (
      path.includes(`${sep}.git${sep}`) ||
      path.endsWith(`${sep}.git`) ||
      path.includes(`${sep}node_modules${sep}`)
    )
  }
}

/**
 * Watch the vault and re-`refresh()` (regenerate the review note) on every
 * change, debounced. Writes to the review folder are ignored so the watcher
 * never reacts to its own output. Resolves once the watcher is ready.
 */
export async function runWatch(
  engine: ReviewEngine,
  config: ResolvedConfig,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = options.debounceMs ?? 300

  // Serialize refreshes: if one is running, mark dirty and re-run when it ends.
  let running = false
  let dirty = false
  const refresh = async (): Promise<void> => {
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      do {
        dirty = false
        const status = await engine.refresh()
        options.onRefresh?.(status)
      } while (dirty)
    } finally {
      running = false
    }
  }

  // Initial pass so the review note reflects the current state immediately.
  await refresh()

  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, debounceMs)
  }

  const watcher = chokidar.watch(config.vaultPath, {
    ignoreInitial: true,
    usePolling: options.poll ?? false,
    ignored: makeIgnorer(config.vaultPath, config.reviewFolder),
  })
  watcher.on('all', schedule)

  await new Promise<void>((resolveReady) => {
    watcher.once('ready', () => resolveReady())
  })
  options.onReady?.()

  return {
    close: async (): Promise<void> => {
      if (timer) clearTimeout(timer)
      await watcher.close()
    },
  }
}
