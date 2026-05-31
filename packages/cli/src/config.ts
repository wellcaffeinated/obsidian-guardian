import { isAbsolute, relative, resolve } from 'node:path'
import type { EngineConfig } from '@obsidian-guardian/engine'

/**
 * Default review folder. Kept in sync with the engine's `DEFAULT_REVIEW_FOLDER`
 * so the watcher knows which path to ignore (the engine does not export it).
 */
export const DEFAULT_REVIEW_FOLDER = '_OG'

/** Raw, unresolved configuration (CLI flags merged later with env + cwd). */
export interface ConfigInput {
  /** Vault folder (the work-tree). Default: `$OG_VAULT` or the cwd. */
  vault?: string
  /** Git database, OUTSIDE the vault. Default: `$OG_GIT_DIR` or `<vault>.gitdir`. */
  gitDir?: string
  /** Review-artifact folder, vault-relative. Default: `$OG_REVIEW_FOLDER` or `_OG`. */
  reviewFolder?: string
  /** Extra ignore globs appended to the managed `info/exclude` block. */
  ignore?: string[]
  /** Per-replica id for the review filename. Default: `$OG_REPLICA_ID` or a
   *  random id persisted in the gitDir. */
  replicaId?: string
}

/** A fully-resolved {@link EngineConfig} with `reviewFolder` always set. */
export interface ResolvedConfig extends EngineConfig {
  reviewFolder: string
}

/** The sibling git database for a vault: outside the tree, never synced. */
function defaultGitDir(vaultPath: string): string {
  return `${vaultPath}.gitdir`
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

/**
 * Resolve CLI input + environment into an absolute {@link ResolvedConfig}.
 * Precedence: explicit flag → environment variable → built-in default.
 */
export function resolveConfig(
  input: ConfigInput,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ResolvedConfig {
  const vaultPath = resolve(cwd, input.vault ?? env.OG_VAULT ?? '.')
  const reviewFolder =
    input.reviewFolder ?? env.OG_REVIEW_FOLDER ?? DEFAULT_REVIEW_FOLDER
  const gitDir = resolve(
    cwd,
    input.gitDir ?? env.OG_GIT_DIR ?? defaultGitDir(vaultPath),
  )
  assertOutsideVault(vaultPath, gitDir)
  const replicaId = input.replicaId ?? env.OG_REPLICA_ID
  return { vaultPath, gitDir, reviewFolder, ignore: input.ignore, replicaId }
}
