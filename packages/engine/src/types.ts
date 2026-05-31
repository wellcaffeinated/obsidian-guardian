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
