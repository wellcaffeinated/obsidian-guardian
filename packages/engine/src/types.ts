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
 * Identity used when the engine advances the baseline marker (a commit).
 */
export interface Author {
  name: string
  email: string
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
