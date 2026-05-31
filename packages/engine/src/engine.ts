import * as fs from 'node:fs'
import { basename, dirname, join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import {
  DEFAULT_AUTHOR,
  DEFAULT_IGNORE,
  DEFAULT_MARKER,
  DEFAULT_REVIEW_FOLDER,
} from './defaults'
import { decode, isBinary, lineStats } from './diff-stats'
import {
  add,
  commit,
  type GitCtx,
  init,
  type RawChange,
  readMarkerBlob,
  remove,
  resolveRef,
  walkChanges,
  writeTag,
} from './git-ops'
import { defaultMachineId, reviewNoteName } from './machine-id'
import { renderReviewNote } from './review-note'
import type { Author, ChangeEntry, EngineConfig, Status } from './types'

const MANAGED_BEGIN = '# >>> obsidian-guardian managed >>>'
const MANAGED_END = '# <<< obsidian-guardian managed <<<'

/** Replace (or append) the engine-managed block in an `info/exclude` body. */
function upsertManagedBlock(existing: string, lines: string[]): string {
  const block = [MANAGED_BEGIN, ...lines, MANAGED_END].join('\n')
  const begin = existing.indexOf(MANAGED_BEGIN)
  const end = existing.indexOf(MANAGED_END)
  if (begin !== -1 && end !== -1 && end > begin) {
    const before = existing.slice(0, begin)
    const after = existing.slice(end + MANAGED_END.length)
    return `${before}${block}${after}`.replace(/\n{3,}/g, '\n\n')
  }
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
  return `${existing}${sep}${block}\n`
}

/**
 * The pure, single-vault review engine. Operations only; no watching, no UI,
 * no argument parsing — adapters decide *when* to call these. Depends on Node
 * `fs` and isomorphic-git only (never Obsidian).
 */
export class ReviewEngine {
  private readonly vaultPath: string
  private readonly gitDir: string
  private readonly reviewFolder: string
  private readonly markerRef: string
  private readonly ignoreGlobs: string[]
  private readonly author: Author
  private readonly matcher: Ignore
  /** Filename of the generated review note (per-machine: `changes-<hash>.md`). */
  readonly reviewNoteName: string

  constructor(config: EngineConfig) {
    this.vaultPath = config.vaultPath
    this.gitDir = config.gitDir
    this.reviewFolder = config.reviewFolder ?? DEFAULT_REVIEW_FOLDER
    this.markerRef = config.markerRef ?? DEFAULT_MARKER
    this.author = config.author ?? DEFAULT_AUTHOR
    this.reviewNoteName = reviewNoteName(config.machineId ?? defaultMachineId())
    this.ignoreGlobs = [
      ...DEFAULT_IGNORE,
      ...(config.ignore ?? []),
      `${this.reviewFolder}/`,
    ]
    this.matcher = ignore().add(this.ignoreGlobs)
  }

  private get ctx(): GitCtx {
    return { dir: this.vaultPath, gitdir: this.gitDir, ref: this.markerRef }
  }

  private get vaultName(): string {
    return basename(this.vaultPath)
  }

  private isIgnored = (path: string): boolean =>
    path.length > 0 && this.matcher.ignores(path)

  /**
   * Initialise the repo if absent, seed the managed `info/exclude`, and set the
   * baseline marker to the current state. Idempotent: re-running only refreshes
   * the managed ignore block, never advancing the marker.
   */
  async onboard(): Promise<void> {
    const existing = await resolveRef(this.ctx)
    if (existing) {
      this.seedExclude()
      return
    }
    await init(this.ctx)
    this.seedExclude()
    // Empty commit first so the marker resolves, then capture current state.
    await commit(this.ctx, this.author, 'chore: initialize baseline')
    await this.commitAll('chore: baseline')
  }

  /** Compute pending changes relative to the baseline marker. */
  async status(): Promise<Status> {
    const changes = await this.buildChanges()
    changes.sort((a, b) => a.path.localeCompare(b.path))
    return {
      marker: await resolveRef(this.ctx),
      generatedAt: new Date().toISOString(),
      clean: changes.length === 0,
      changes,
    }
  }

  /** Compute status and (re)write the review note. Returns the status. */
  async refresh(): Promise<Status> {
    const status = await this.status()
    const dir = join(this.vaultPath, this.reviewFolder)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      join(dir, this.reviewNoteName),
      renderReviewNote(status, this.vaultName),
    )
    return status
  }

  /** Advance the baseline marker to the current state. */
  async bless(): Promise<void> {
    await this.commitAll('chore: bless baseline')
  }

  /** Restore a single path from the baseline (or delete it if newly added). */
  async revert(path: string): Promise<void> {
    await this.restore(path)
  }

  /** Restore the whole work-tree to the baseline. */
  async rollback(): Promise<void> {
    const changes = await walkChanges(this.ctx, this.isIgnored)
    for (const change of changes) {
      await this.restore(change.path)
    }
  }

  /** Create a named snapshot (lightweight tag) at the current marker. */
  async tag(name: string): Promise<void> {
    await writeTag(this.ctx, name)
  }

  private async commitAll(message: string): Promise<void> {
    const changes = await walkChanges(this.ctx, this.isIgnored)
    if (changes.length === 0) return
    for (const change of changes) {
      if (change.workdirOid === null) await remove(this.ctx, change.path)
      else await add(this.ctx, change.path)
    }
    await commit(this.ctx, this.author, message)
  }

  /** Restore one path's content from the marker, keeping the index in sync. */
  private async restore(path: string): Promise<void> {
    const abs = join(this.vaultPath, path)
    const blob = await readMarkerBlob(this.ctx, path)
    if (blob) {
      await fs.promises.mkdir(dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, blob.blob)
      await add(this.ctx, path)
    } else {
      await fs.promises.rm(abs, { force: true })
      await remove(this.ctx, path)
    }
  }

  private seedExclude(): void {
    const infoDir = join(this.gitDir, 'info')
    fs.mkdirSync(infoDir, { recursive: true })
    const file = join(infoDir, 'exclude')
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    fs.writeFileSync(file, upsertManagedBlock(existing, this.ignoreGlobs))
  }

  private async readWorkdir(path: string): Promise<Uint8Array | null> {
    try {
      return await fs.promises.readFile(join(this.vaultPath, path))
    } catch {
      return null
    }
  }

  /** Build the change list, including exact-content rename detection. */
  private async buildChanges(): Promise<ChangeEntry[]> {
    const raw = await walkChanges(this.ctx, this.isIgnored)
    const adds = raw.filter((c) => c.headOid === null)
    const deletes = raw.filter((c) => c.workdirOid === null)
    const modifies = raw.filter(
      (c) => c.headOid !== null && c.workdirOid !== null,
    )

    const deletedByOid = new Map<string, RawChange>()
    for (const change of deletes) {
      if (change.headOid) deletedByOid.set(change.headOid, change)
    }

    const changes: ChangeEntry[] = []
    const matched = new Set<string>()

    for (const change of adds) {
      const from =
        change.workdirOid != null
          ? deletedByOid.get(change.workdirOid)
          : undefined
      if (from && !matched.has(from.path)) {
        matched.add(from.path)
        const bytes = (await this.readWorkdir(change.path)) ?? new Uint8Array()
        changes.push({
          path: change.path,
          kind: 'rename',
          renamedFrom: from.path,
          added: 0,
          removed: 0,
          binary: isBinary(bytes),
        })
      } else {
        const after = await this.readWorkdir(change.path)
        changes.push({
          path: change.path,
          kind: 'add',
          ...this.stats(null, after),
        })
      }
    }

    for (const change of deletes) {
      if (matched.has(change.path)) continue
      const before = await readMarkerBlob(this.ctx, change.path)
      changes.push({
        path: change.path,
        kind: 'delete',
        ...this.stats(before?.blob ?? null, null),
      })
    }

    for (const change of modifies) {
      const before = await readMarkerBlob(this.ctx, change.path)
      const after = await this.readWorkdir(change.path)
      changes.push({
        path: change.path,
        kind: 'modify',
        ...this.stats(before?.blob ?? null, after),
      })
    }

    return changes
  }

  private stats(
    before: Uint8Array | null,
    after: Uint8Array | null,
  ): { added: number; removed: number; binary: boolean } {
    const b = before ?? new Uint8Array()
    const a = after ?? new Uint8Array()
    if (isBinary(b) || isBinary(a))
      return { added: 0, removed: 0, binary: true }
    return { ...lineStats(decode(b), decode(a)), binary: false }
  }
}
