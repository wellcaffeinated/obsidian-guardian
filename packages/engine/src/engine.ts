import { basename, dirname, join } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import type { PromiseFsClient } from 'isomorphic-git'
import { renderChangesFile } from './changes-file'
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
  type FlatEntry,
  type GitCtx,
  hashBlob,
  init,
  type RawChange,
  readCommitTime,
  readFlatTree,
  readMarkerBlob,
  readTreeOid,
  remove,
  resolveRef,
  walkChanges,
  writeBlob,
  writeFlatTree,
  writeRef,
  writeTag,
} from './git-ops'
import { readLocalState, writeLocalState } from './local-state'
import {
  changesFileName,
  changesFilePrefix,
  readOrCreateReplicaId,
  reviewNoteName,
} from './replica-id'
import { renderReviewNote } from './review-note'
import {
  nextSeq,
  readBlessHighWater,
  readSeq,
  writeBlessHighWater,
} from './state'
import {
  type ApplyResult,
  type Author,
  type BlessRecord,
  type ChangeEntry,
  DELETED,
  type EngineConfig,
  type Manifest,
  type SnapshotStatus,
  type Status,
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
  private readonly fs: PromiseFsClient
  private readonly vaultPath: string
  private readonly gitDir: string
  private readonly reviewFolder: string
  private readonly markerRef: string
  private readonly ignoreGlobs: string[]
  private readonly author: Author
  private readonly matcher: Ignore
  private readonly configReplicaId: string | undefined
  private resolvedReplicaId: string | undefined
  private resolvedReviewNoteName: string | undefined

  constructor(config: EngineConfig) {
    this.fs = config.fs
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
    return {
      fs: this.fs,
      dir: this.vaultPath,
      gitdir: this.gitDir,
      ref: this.markerRef,
    }
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

  /** Resolve (once) and cache this replica's id. */
  private async ensureReplicaId(): Promise<string> {
    if (this.resolvedReplicaId === undefined) {
      this.resolvedReplicaId =
        this.configReplicaId ?? (await readOrCreateReplicaId(this.gitDir))
    }
    return this.resolvedReplicaId
  }

  /** Resolve (once) and cache this replica's review-note filename. */
  private async ensureReviewNoteName(): Promise<string> {
    if (this.resolvedReviewNoteName === undefined) {
      this.resolvedReviewNoteName = reviewNoteName(await this.ensureReplicaId())
    }
    return this.resolvedReviewNoteName
  }

  /**
   * Filename prefix shared by this replica's rotating signal files. Valid after
   * {@link onboard}. A watcher matches this to act only on its own files.
   */
  get signalPrefix(): string {
    if (this.resolvedReplicaId === undefined) {
      throw new Error('signalPrefix is available after onboard()')
    }
    return changesFilePrefix(this.resolvedReplicaId)
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
      await this.seedExclude()
      await this.ensureReviewNoteName()
      return false
    }
    await init(this.ctx)
    await this.seedExclude()
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
    await this.fs.promises.mkdir(dir, { recursive: true })
    const name = await this.ensureReviewNoteName()
    await this.fs.promises.writeFile(
      join(dir, name),
      renderReviewNote(status, this.vaultName),
    )
    return status
  }

  /**
   * Approve the current working tree: build a **delta manifest** (the paths
   * changed since baseline, as absolute content hashes plus {@link DELETED}
   * tombstones), advance our own baseline through {@link applyBless}, and record
   * the bless in local state. Returns the {@link BlessRecord} so the adapter can
   * publish it to the synced signal folder (see the coordination layer).
   *
   * Crash-safe ordering: the baseline ref move (atomic) happens before we persist
   * `blessSeq`; a crash between the two is recoverable by re-deriving the record
   * from `baseline`'s parent→baseline diff on the next ingest.
   */
  async bless(): Promise<BlessRecord> {
    const self = await this.ensureReplicaId()
    const changes = await walkChanges(this.ctx, this.isIgnored)
    const manifest: Manifest = changes.map((c) => ({
      path: c.path,
      hash: c.workdirOid === null ? DELETED : c.workdirOid,
    }))
    const state = await readLocalState(this.fs, this.gitDir, self)
    const rec: BlessRecord = {
      client: self,
      seq: state.blessSeq + 1,
      manifest,
      blessedAt: new Date().toISOString(),
    }
    await this.applyBless(rec)
    state.blessSeq = rec.seq
    state.observedSeq[self] = rec.seq
    await writeLocalState(this.fs, this.gitDir, state)
    return rec
  }

  /**
   * The core convergence rule: apply a bless record **per file, content-gated**.
   * For each manifest entry, advance the baseline for that path **only if** this
   * device's own (synced) working tree already hashes to the blessed value (or,
   * for {@link DELETED}, the path is already absent). That single content gate is
   * simultaneously the arrival gate (bytes not synced yet), the causal cut (a
   * newer local edit won't match an older blessed hash), and the conflict
   * resolver (only the bless matching current content admits) — so the fold is
   * idempotent, commutative, and convergent with no vector clock.
   *
   * Builds a new baseline tree (old baseline overlaid with the admitted paths'
   * blobs) and moves the `baseline` ref in one atomic commit. The working tree is
   * never touched. Returns whether the baseline advanced and whether any entries
   * are still gated (to retry on a later ingest).
   */
  async applyBless(rec: BlessRecord): Promise<ApplyResult> {
    const baselineCommit = await resolveRef(this.ctx)
    const entries: Map<string, FlatEntry> = baselineCommit
      ? await readFlatTree(this.ctx, await readTreeOid(this.ctx, baselineCommit))
      : new Map()

    let changed = false
    let stillPending = false
    for (const entry of rec.manifest) {
      if (entry.hash === DELETED) {
        // Content gate (delete): the bytes must already be gone locally.
        if ((await this.readWorkdir(entry.path)) !== null) {
          stillPending = true
          continue
        }
        if (entries.delete(entry.path)) changed = true
      } else {
        const bytes = await this.readWorkdir(entry.path)
        // Content gate (set): local bytes must hash to the blessed value.
        if (!bytes || (await hashBlob(bytes)) !== entry.hash) {
          stillPending = true
          continue
        }
        const oid = await writeBlob(this.ctx, bytes)
        const prev = entries.get(entry.path)
        if (!prev || prev.oid !== oid) {
          entries.set(entry.path, { oid, mode: prev?.mode ?? '100644' })
          changed = true
        }
      }
    }

    if (changed) {
      const newTree = await writeFlatTree(this.ctx, entries)
      await commitTree(
        this.ctx,
        this.author,
        `bless: apply ${rec.client.slice(0, 8)}:${rec.seq}`,
        newTree,
        baselineCommit ? [baselineCommit] : [],
      )
    }
    return { changed, stillPending }
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

  /**
   * Snapshot the current tree and write its rotating, immutable signal file
   * (`<reviewFolder>/changes-<replica>-<snap8>.md`). Returns the status, the
   * filename written, and the exact bytes written (so a watcher can record a
   * self-write hash and not react to its own output). Does not delete superseded
   * files — retention is the adapter's concern.
   */
  async writeSnapshot(): Promise<{
    status: SnapshotStatus
    fileName: string
    content: string
  }> {
    const status = await this.snapshot()
    const fileName = changesFileName(
      await this.ensureReplicaId(),
      status.snapshot,
    )
    const content = renderChangesFile(status, this.vaultName)
    const dir = join(this.vaultPath, this.reviewFolder)
    await this.fs.promises.mkdir(dir, { recursive: true })
    await this.fs.promises.writeFile(join(dir, fileName), content)
    return { status, fileName, content }
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
      await this.fs.promises.mkdir(dirname(abs), { recursive: true })
      await this.fs.promises.writeFile(abs, blob.blob)
      await add(this.ctx, path)
    } else {
      try {
        await this.fs.promises.unlink(abs)
      } catch {
        // already absent — nothing to remove from the work-tree
      }
      await remove(this.ctx, path)
    }
  }

  private async seedExclude(): Promise<void> {
    const infoDir = join(this.gitDir, 'info')
    await this.fs.promises.mkdir(infoDir, { recursive: true })
    const file = join(infoDir, 'exclude')
    let existing = ''
    try {
      existing = (await this.fs.promises.readFile(file, 'utf8')) as string
    } catch {
      existing = ''
    }
    await this.fs.promises.writeFile(
      file,
      upsertManagedBlock(existing, this.ignoreGlobs),
    )
  }

  private async readWorkdir(path: string): Promise<Uint8Array | null> {
    try {
      return (await this.fs.promises.readFile(
        join(this.vaultPath, path),
      )) as Uint8Array
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
