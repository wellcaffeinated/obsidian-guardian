import { sha256Hex } from '@obsidian-guardian/engine'
import { join } from 'pathe'

/**
 * Desktop-only environment bits. Safe to bundle into the single `main.js` loaded
 * on every platform **because the `node:` builtins are pulled in via a runtime
 * `require` inside functions** — never a top-level `import` — so they only
 * execute when these functions run on the desktop branch of `resolveEnv`. On
 * mobile (no Node) they are never called, so `require('node:fs')` never fires.
 *
 * (Obsidian/Electron provides `require` on desktop; it's typed via @types/node.)
 */

/** The desktop working-tree + object-store backend: real `node:fs` (its
 * `.promises` surface structurally satisfies isomorphic-git's `PromiseFsClient`). */
export function desktopFs(): typeof import('node:fs') {
  return require('node:fs')
}

/** Per-OS app-data root — the git database lives here, never inside the synced vault. */
function appDataRoot(): string {
  const { homedir }: typeof import('node:os') = require('node:os')
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
 * machines holding the same synced vault) never collide. Uses the engine's
 * mobile-safe `sha256Hex` (not `node:crypto`).
 */
export function defaultGitDir(vaultPath: string, vaultName: string): string {
  const hash = sha256Hex(vaultPath).slice(0, 16)
  return join(appDataRoot(), 'obsidian-guardian', `${vaultName}-${hash}`)
}
