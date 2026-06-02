import type { PromiseFsClient } from 'isomorphic-git'

/**
 * The kind of change a file underwent relative to the baseline marker.
 */
export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename'

/**
 * A single file's change relative to the baseline marker.
 */
export interface ChangeEntry {
  /** Vault-relative path (forward slashes). For renames, the new path. */
  path: string
  kind: ChangeKind
  /** For renames, the previous path. */
  renamedFrom?: string
  /** Number of lines added. Always 0 for binary files. */
  added: number
  /** Number of lines removed. Always 0 for binary files. */
  removed: number
  /** True when the file could not be diffed line-by-line (binary content). */
  binary: boolean
}

/**
 * A complete snapshot of what is pending relative to the baseline marker.
 */
export interface Status {
  /** Current marker (baseline) commit SHA, or null if the repo has no commits. */
  marker: string | null
  /** ISO-8601 timestamp of when this status was computed. */
  generatedAt: string
  /** True when nothing is pending. */
  clean: boolean
  /** One entry per changed file, sorted by path. */
  changes: ChangeEntry[]
}

/**
 * A pending review pinned to an immutable snapshot commit. Unlike {@link Status}
 * (a live diff against the working tree), a SnapshotStatus references a specific
 * checkpoint by oid so a bless signal can target *exactly the reviewed state*,
 * even after the working tree has moved on.
 */
export interface SnapshotStatus {
  /** Full 40-char oid of the checkpoint commit — the bless target. */
  snapshot: string
  /** Monotonic per-gitDir sequence number for this snapshot. */
  seq: number
  /** Current baseline (trusted) commit oid, or null if the repo has no commits. */
  baseline: string | null
  /** ISO-8601 timestamp the baseline commit was made, or null. */
  baselineAt: string | null
  /** ISO-8601 timestamp this snapshot was computed. */
  generatedAt: string
  /** True when the snapshot equals the baseline (nothing to bless). */
  clean: boolean
  /** Net change list from baseline to the snapshot, sorted by path. */
  changes: ChangeEntry[]
}

/**
 * One device-local checkpoint: an immutable snapshot commit parented on the
 * baseline-at-creation, identified by its commit oid and monotonic seq.
 */
export interface Checkpoint {
  /** Full 40-char checkpoint commit oid. */
  oid: string
  /** Monotonic per-gitDir sequence number. */
  seq: number
  /** ISO-8601 commit time of the checkpoint. */
  when: string
}

/** A checkpoint plus the net changes from it to the current working tree. */
export interface TimelineEntry extends Checkpoint {
  /** Net change list from this checkpoint → the working tree, sorted by path. */
  changes: ChangeEntry[]
}

/**
 * The review timeline the panel renders: the live `current` diff
 * (baseline→working tree), the `baseline` marker, and the device-local
 * `checkpoints` (newest seq first), each carrying its diff to the working tree.
 */
export interface Timeline {
  /** Baseline (last blessed) commit oid + its commit time, or nulls if none. */
  baseline: { oid: string | null; when: string | null }
  /** Pending changes from baseline → the working tree, sorted by path. */
  current: ChangeEntry[]
  /** Device-local checkpoints, newest seq first. */
  checkpoints: TimelineEntry[]
}

/**
 * Identity used when the engine advances the baseline marker (a commit).
 */
export interface Author {
  name: string
  email: string
}

// ---------------------------------------------------------------------------
// P2P bless coordination (see plans/p2p-bless-protocol.md)
// ---------------------------------------------------------------------------

/**
 * Stable per-device id. A random id persisted in the device-local (non-synced)
 * gitDir — NEVER a synced setting, since a shared id would collide every device
 * onto one signal file. One {@link DeviceState} + one {@link BlessRecord} file
 * is written per ClientId (single-writer ⇒ no sync-conflict copies).
 */
export type ClientId = string

/**
 * Content address of a file's bytes: the git blob sha. The cross-device
 * coordination currency — identical everywhere for identical bytes,
 * path- and history-independent. Each device's object store is private, so only
 * the *hash* must agree, not the storage layout.
 */
export type Hash = string

/** Monotonic per-client counter. Used only for dedup, freshness, and GC. */
export type Seq = number

/** Vault-relative posix path. */
export type Path = string

/**
 * Explicit deletion sentinel — NOT null. Omission from a manifest means
 * "unchanged from baseline", so a delete must be stated. A hex hash can never
 * collide with this literal.
 */
export const DELETED = 'DELETED' as const

/** One path's blessed content address (or a tombstone). */
export interface ManifestEntry {
  path: Path
  /** Absolute content hash, or {@link DELETED} when the path was removed. */
  hash: Hash | typeof DELETED
}

/**
 * Delta only: the paths the blesser perceived as changed from ITS baseline.
 * Inclusion is baseline-relative; the hash value is absolute. That split lets a
 * receiver with a *different* baseline still apply it per-path.
 */
export type Manifest = ManifestEntry[]

/**
 * A device's published presence/housekeeping state (synced JSON). Never carries
 * correctness — the content gate in `applyBless` does that. `observedSeq` drives
 * dedup + GC only.
 */
export interface DeviceState {
  client: ClientId
  /** This device's latest checkpoint seq. */
  head: Seq
  /** Optional digest of its baseline tree, for UI/divergence display. */
  baselineDigest?: Hash
  /** Latest bless `seq` this device has ingested from each peer (incl. self). */
  observedSeq: Record<ClientId, Seq>
  /** ISO-8601; staleness/UI only, NOT correctness. */
  updatedAt: string
}

/** The approval record a device publishes (synced JSON, overwritten in place). */
export interface BlessRecord {
  client: ClientId
  /** This client's bless sequence (monotonic). */
  seq: Seq
  /** Delta from the blesser's baseline → the blessed checkpoint (absolute hashes). */
  manifest: Manifest
  /** ISO-8601; display + freshness/GC only. */
  blessedAt: string
}

/**
 * Per-device coordination state persisted in the non-synced gitDir, so a crash
 * never loses an in-flight bless obligation. `self`/`head` mirror the persisted
 * ClientId / checkpoint seq; `pending` holds received blesses whose bytes have
 * not yet synced in (retried each ingest, pruned by the freshness window).
 */
export interface LocalState {
  self: ClientId
  observedSeq: Record<ClientId, Seq>
  /** This device's own latest bless seq. */
  blessSeq: Seq
  pending: BlessRecord[]
}

/** Outcome of applying a single bless record (per-file content gate). */
export interface ApplyResult {
  /** Baseline ref advanced (at least one path passed the gate and changed). */
  changed: boolean
  /** Some manifest entries did not match the working tree yet (retry/prune). */
  stillPending: boolean
}

/**
 * Configuration for a single-vault {@link ReviewEngine}.
 */
export interface EngineConfig {
  /**
   * Injected filesystem (isomorphic-git's `PromiseFsClient` — any object with a
   * `.promises` API: readFile/writeFile/mkdir/unlink/readdir/stat/lstat/rmdir).
   * Node's `fs` satisfies it (desktop/CLI); on mobile a vault-adapter +
   * IndexedDB shim is provided. Required so the engine carries no static
   * `node:fs` import and can run on Obsidian mobile.
   */
  fs: PromiseFsClient
  /** Absolute path to the vault folder (the git work-tree). */
  vaultPath: string
  /** Absolute path to the git database, OUTSIDE the synced tree (app-data). */
  gitDir: string
  /** Folder (vault-relative) for review artifacts. Default `_Review`. */
  reviewFolder?: string
  /** Branch name used as the advanceable baseline marker. Default `baseline`. */
  markerRef?: string
  /** Extra ignore globs appended to the managed `info/exclude` block. */
  ignore?: string[]
  /** Identity recorded on bless/baseline commits. */
  author?: Author
  /**
   * Stable id for this replica (this gitDir / working copy). The review note is
   * named `changes-<hash>.md` from it, so a synced vault reviewed from multiple
   * replicas never collides on one file. Defaults to a random id persisted in
   * the gitDir (`<gitDir>/obsidian-guardian/replica-id`).
   */
  replicaId?: string
}
