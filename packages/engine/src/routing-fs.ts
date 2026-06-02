import type { PromiseFsClient } from 'isomorphic-git'

/**
 * The `.promises` surface isomorphic-git requires of an injected filesystem.
 * The engine uses a strict subset (readFile/writeFile/mkdir/unlink/readdir);
 * isomorphic-git adds rmdir/stat/lstat and the optional readlink/symlink/chmod.
 */
type Promises = PromiseFsClient['promises']

/** Does `path` equal or sit beneath `base`? Both are absolute, posix-ish. */
function isUnder(path: string, base: string): boolean {
  const p = path.replace(/\/+$/, '')
  const b = base.replace(/\/+$/, '')
  return p === b || p.startsWith(`${b}/`)
}

export interface RoutingFsOptions {
  /**
   * Absolute path prefix that selects the device-local object-store backend.
   * Every path under it routes to {@link RoutingFsOptions.gitDirFs}; everything
   * else (the synced working tree) routes to
   * {@link RoutingFsOptions.workTreeFs}.
   */
  gitDir: string
  /** Backend for object-store paths under {@link RoutingFsOptions.gitDir}. */
  gitDirFs: PromiseFsClient
  /** Backend for all other paths (the synced working tree / vault). */
  workTreeFs: PromiseFsClient
}

/**
 * Compose two `PromiseFsClient` backends into one that isomorphic-git can use as
 * a single injected `fs`, **routing each call by path**: paths under `gitDir` go
 * to the device-local object store, everything else to the working tree. This is
 * the seam that lets the engine run unchanged while the two filesystems differ
 * per platform — on desktop both backends are `node:fs`; on mobile the worktree
 * is `app.vault.adapter` and the gitdir is an IndexedDB-backed `fs.promises`,
 * which can never share one `fs` (no path "outside the vault" exists there).
 *
 * isomorphic-git insists on one `fs` for both work-tree and gitdir; the router
 * satisfies that contract without rewriting the engine to a from-scratch
 * object-db. Paths are dispatched verbatim — each backend interprets the
 * (absolute) path it receives, exactly as it does today on desktop.
 */
type AnyFn = (...args: unknown[]) => unknown

export function createRoutingFs(options: RoutingFsOptions): PromiseFsClient {
  const { gitDir, gitDirFs, workTreeFs } = options
  const promisesFor = (path: unknown): Record<string, AnyFn | undefined> =>
    (typeof path === 'string' && isUnder(path, gitDir)
      ? gitDirFs.promises
      : workTreeFs.promises) as unknown as Record<string, AnyFn | undefined>

  /** Route by the path found at `pathArg` (1 for symlink's link location). */
  const dispatch =
    (name: string, pathArg: number): AnyFn =>
    (...args: unknown[]): unknown => {
      const target = promisesFor(args[pathArg])
      const fn = target[name]
      if (typeof fn !== 'function') {
        throw new Error(`routing fs: backend has no '${name}'`)
      }
      return fn.apply(target, args)
    }

  const promises: Promises = {
    readFile: dispatch('readFile', 0),
    writeFile: dispatch('writeFile', 0),
    unlink: dispatch('unlink', 0),
    readdir: dispatch('readdir', 0),
    mkdir: dispatch('mkdir', 0),
    rmdir: dispatch('rmdir', 0),
    stat: dispatch('stat', 0),
    lstat: dispatch('lstat', 0),
    // symlink(target, path) — the link is created at the SECOND argument.
    symlink: dispatch('symlink', 1),
    readlink: dispatch('readlink', 0),
    chmod: dispatch('chmod', 0),
  }
  return { promises }
}
