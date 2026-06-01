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
  commitIndex,
  commitTree,
  type GitCtx,
  init,
  type RawChange,
  readCommitTime,
  readMarkerBlob,
  readTreeOid,
  remove,
  resolveRef,
  walkChanges,
  writeRef,
  writeTag,
} from './git-ops'
import { readOrCreateReplicaId, reviewNoteName } from './replica-id'
import { renderReviewNote } from './review-note'
import {
  nextSeq,
  readBlessHighWater,
  readSeq,
  writeBlessHighWater,
} from './state'
import type {
  Author,
  ChangeEntry,
  EngineConfig,
  SnapshotStatus,
  Status,
} from './types'

const MANAGED_BEGIN = '# >>> obsidian-guardian managed >>>'
const MANAGED_END = '# <<< obsidian-guardian managed <<<'

/** Zero-pad a seq so checkpoint refs sort lexicographically by recency. */
function pad(seq: number): string {
  return String(seq).padStart(12, '0')
}

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
  private readonly configReplicaId: string | undefined
  private resolvedReviewNoteName: string | undefined

  constructor(config: EngineConfig) {
    this.vaultPath = config.vaultPath
    this.gitDir = config.gitDir
    this.reviewFolder = config.reviewFolder ?? DEFAULT_REVIEW_FOLDER
    this.markerRef = config.markerRef ?? DEFAULT_MARKER
    this.author = config.author ?? DEFAULT_AUTHOR
    this.configReplicaId = config.replicaId
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
   * Filename of the generated review note for this replica: `changes-<hash>.md`,
   * derived from a per-gitDir id. Valid after {@link onboard} (or the first
   * {@link refresh}); throws if read before the id has been resolved.
   */
  get reviewNoteName(): string {
    if (this.resolvedReviewNoteName === undefined) {
      throw new Error('reviewNoteName is available after onboard()')
    }
    return this.resolvedReviewNoteName
  }

  /** Resolve (once) and cache this replica's review-note filename. */
  private async ensureReviewNoteName(): Promise<string> {
    if (this.resolvedReviewNoteName === undefined) {
      const replicaId =
        this.configReplicaId ?? (await readOrCreateReplicaId(this.gitDir))
      this.resolvedReviewNoteName = reviewNoteName(replicaId)
    }
    return this.resolvedReviewNoteName
  }

  /**
   * Initialise the repo if absent, seed the managed `info/exclude`, and set the
   * baseline marker to the current state. Idempotent: re-running only refreshes
   * the managed ignore block, never advancing the marker.
   *
   * Returns `true` when it freshly initialised the repo (the first-ever onboard
   * for this gitDir), `false` when an existing baseline was found. Adapters use
   * this to do one-time first-activation work (e.g. settling the host app's own
   * config writes that land just after the baseline).
   */
  async onboard(): Promise<boolean> {
    const existing = await resolveRef(this.ctx)
    if (existing) {
      this.seedExclude()
      await this.ensureReviewNoteName()
      return false
    }
    await init(this.ctx)
    this.seedExclude()
    await this.ensureReviewNoteName()
    // Empty commit first so the marker resolves, then capture current state.
    await commit(this.ctx, this.author, 'chore: initialize baseline')
    await this.commitAll('chore: baseline')
    return true
  }

  /**
   * Whether this gitDir already holds an initialised baseline (i.e. a prior
   * {@link onboard} ran for it). Pure check — never creates the repo — so
   * adapters can gate first-time activation behind an explicit user action
   * instead of silently onboarding on every machine that opens a synced vault.
   */
  async isOnboarded(): Promise<boolean> {
    return (await resolveRef(this.ctx)) !== null
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
    const name = await this.ensureReviewNoteName()
    fs.writeFileSync(join(dir, name), renderReviewNote(status, this.vaultName))
    return status
  }

  /** Advance the baseline marker to the current state. */
  async bless(): Promise<void> {
    await this.commitAll('chore: bless baseline')
  }

  /**
   * Snapshot the current working tree to an immutable checkpoint commit, parented
   * on the current baseline (a *sibling* of any other checkpoints since the last
   * bless), and return its oid + a monotonic seq. The checkpoint does **not**
   * advance the baseline marker. No-op when the tree equals the baseline: returns
   * the baseline oid and the current seq without creating a commit.
   *
   * The seq is the bless protocol's ordering key; the oid is the bless target
   * (blessable later even if its ref is dropped, since the commit object lingers).
   */
  async checkpoint(): Promise<{ oid: string; seq: number; created: boolean }> {
    const baseline = await resolveRef(this.ctx)
    const changes = await walkChanges(this.ctx, this.isIgnored)
    if (changes.length === 0) {
      return {
        oid: baseline ?? '',
        seq: await readSeq(this.gitDir),
        created: false,
      }
    }
    for (const change of changes) {
      if (change.workdirOid === null) await remove(this.ctx, change.path)
      else await add(this.ctx, change.path)
    }
    const oid = await commitIndex(
      this.ctx,
      this.author,
      'checkpoint: snapshot',
      baseline ? [baseline] : [],
    )
    const seq = await nextSeq(this.gitDir)
    await writeRef(this.ctx, `refs/og/checkpoints/${pad(seq)}`, oid)
    return { oid, seq, created: true }
  }

  /**
   * Bless a pinned snapshot: advance the baseline to the snapshot commit's tree,
   * iff `seq` is strictly greater than the locally-persisted high-water mark.
   * Otherwise a no-op (returns false) — this is what makes the signal
   * order-independent and idempotent: stale/duplicate/reordered signals (a lower
   * or equal seq) can never regress the baseline. The working tree is untouched;
   * any changes after the snapshot remain pending.
   */
  async blessSnapshot(oid: string, seq: number): Promise<boolean> {
    if (seq <= (await readBlessHighWater(this.gitDir))) return false
    const tree = await readTreeOid(this.ctx, oid)
    const baseline = await resolveRef(this.ctx)
    await commitTree(
      this.ctx,
      this.author,
      `chore: bless snapshot ${oid.slice(0, 8)}`,
      tree,
      baseline ? [baseline] : [],
    )
    await writeBlessHighWater(this.gitDir, seq)
    return true
  }

  /**
   * Snapshot the current tree and return a {@link SnapshotStatus}: the pinned
   * snapshot oid + seq, the current baseline (and when it was set), and the net
   * change list from baseline to the snapshot. The adapter renders this into a
   * rotating, immutable signal file; `accepted: true` synced back targets
   * {@link blessSnapshot}.
   */
  async snapshot(): Promise<SnapshotStatus> {
    const { oid, seq } = await this.checkpoint()
    const changes = await this.buildChanges()
    changes.sort((a, b) => a.path.localeCompare(b.path))
    const baseline = await resolveRef(this.ctx)
    return {
      snapshot: oid,
      seq,
      baseline,
      baselineAt: baseline ? await readCommitTime(this.ctx, baseline) : null,
      generatedAt: new Date().toISOString(),
      clean: changes.length === 0,
      changes,
    }
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
