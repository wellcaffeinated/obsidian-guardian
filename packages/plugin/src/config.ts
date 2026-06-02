import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import type { EngineConfig } from '@obsidian-guardian/engine'

/** Default review folder — kept in sync with the engine's `DEFAULT_REVIEW_FOLDER`. */
export const DEFAULT_REVIEW_FOLDER = '_OG'
/** Default baseline marker branch — kept in sync with the engine's `DEFAULT_MARKER`. */
export const DEFAULT_MARKER = 'baseline'

/** Persisted plugin settings (via `loadData`/`saveData`). Empty string = "use default". */
export interface PluginSettings {
  /** Explicit git database path. Empty = derive under OS app-data (outside the vault). */
  gitDir: string
  /** Vault-relative review-artifact folder. */
  reviewFolder: string
  /** Baseline marker branch name. */
  markerRef: string
  /** Extra ignore globs, one per line (or comma-separated). */
  ignore: string
  /** Commit author name recorded on bless. Empty = engine default. */
  authorName: string
  /** Commit author email recorded on bless. */
  authorEmail: string
}

export const DEFAULT_SETTINGS: PluginSettings = {
  gitDir: '',
  reviewFolder: DEFAULT_REVIEW_FOLDER,
  markerRef: DEFAULT_MARKER,
  ignore: '',
  authorName: '',
  authorEmail: '',
}

/**
 * A resolved {@link EngineConfig} (paths + settings) with `reviewFolder` always
 * set. `fs` is injected separately by the adapter at engine construction
 * (`new ReviewEngine({ ...resolved, fs })`) — desktop Node fs, or a mobile
 * vault-adapter/IndexedDB shim — so it is not resolved here.
 */
export interface ResolvedConfig extends Omit<EngineConfig, 'fs'> {
  reviewFolder: string
}

/** Per-OS app-data root — the git database lives here, never inside the synced vault. */
function appDataRoot(): string {
  const home = homedir()
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support')
  }
  return process.env.XDG_DATA_HOME ?? join(home, '.local', 'share')
}

/**
 * The default git database for a vault: a per-machine, per-vault folder under
 * OS app-data, keyed by a hash of the absolute vault path so two vaults (or two
 * machines holding the same synced vault) never collide.
 */
export function defaultGitDir(vaultPath: string, vaultName: string): string {
  const hash = createHash('sha256').update(vaultPath).digest('hex').slice(0, 16)
  return join(appDataRoot(), 'obsidian-guardian', `${vaultName}-${hash}`)
}

/** Throw if the git database would live inside the vault (breaks the invariant). */
function assertOutsideVault(vaultPath: string, gitDir: string): void {
  const rel = relative(vaultPath, gitDir)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(
      `git-dir (${gitDir}) must live outside the vault (${vaultPath}); ` +
        'the git database must never sync into the vault tree.',
    )
  }
}

/** Split a free-text ignore field (newline- or comma-separated) into globs. */
function parseIgnore(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Resolve the vault path + persisted settings into an absolute {@link ResolvedConfig}. */
export function resolvePluginConfig(args: {
  vaultPath: string
  vaultName: string
  settings: PluginSettings
}): ResolvedConfig {
  const { vaultPath, vaultName, settings } = args
  const reviewFolder = settings.reviewFolder.trim() || DEFAULT_REVIEW_FOLDER
  const gitDir = settings.gitDir.trim() || defaultGitDir(vaultPath, vaultName)
  assertOutsideVault(vaultPath, gitDir)
  const ignore = parseIgnore(settings.ignore)
  const author = settings.authorName.trim()
    ? { name: settings.authorName.trim(), email: settings.authorEmail.trim() }
    : undefined
  return {
    vaultPath,
    gitDir,
    reviewFolder,
    markerRef: settings.markerRef.trim() || DEFAULT_MARKER,
    ignore: ignore.length > 0 ? ignore : undefined,
    author,
    // No replicaId here on purpose: a synced setting would make every machine
    // share one review-note filename and collide. The engine's own per-gitDir
    // persisted id keeps each machine isolated. (CLI keeps the advanced override.)
  }
}
