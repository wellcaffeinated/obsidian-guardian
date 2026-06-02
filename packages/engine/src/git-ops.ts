import { join } from 'node:path'
import git, { type PromiseFsClient, TREE, WORKDIR } from 'isomorphic-git'
import type { Author } from './types'

/**
 * The minimal context every low-level git operation needs: the injected
 * filesystem (`fs`), the work-tree (`dir` = the vault), the external git
 * database (`gitdir`, outside the synced tree), and the baseline marker branch
 * (`ref`). `fs` is a `PromiseFsClient` so the engine never imports `node:fs`
 * directly — desktop passes Node's `fs`, mobile passes a vault-adapter/IndexedDB
 * shim.
 */
export interface GitCtx {
  fs: PromiseFsClient
  dir: string
  gitdir: string
  ref: string
}

/** A raw change relative to the marker: oids are null when the path is absent. */
export interface RawChange {
  path: string
  headOid: string | null
  workdirOid: string | null
}

/** Resolve a ref to its commit oid, or null if it does not exist. */
export async function resolveRef(
  ctx: GitCtx,
  ref: string = ctx.ref,
): Promise<string | null> {
  try {
    return await git.resolveRef({ fs: ctx.fs, gitdir: ctx.gitdir, ref })
  } catch {
    return null
  }
}

/** Initialise a repo with the marker as the default branch (idempotent). */
export async function init(ctx: GitCtx): Promise<void> {
  await git.init({
    fs: ctx.fs,
    dir: ctx.dir,
    gitdir: ctx.gitdir,
    defaultBranch: ctx.ref,
  })
}

/** Git blob oid for arbitrary bytes (comparable to tree blob oids). */
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const { oid } = await git.hashBlob({ object: bytes })
  return oid
}

/**
 * Detect changes between the marker tree and the work-tree by **content**
 * (hashing each work-tree file), so same-size edits are never missed and no
 * index stat-cache shortcut can hide a change. `isIgnored` is applied before
 * hashing, so ignored files are cheap to skip.
 */
export async function walkChanges(
  ctx: GitCtx,
  isIgnored: (path: string) => boolean,
): Promise<RawChange[]> {
  const marker = await resolveRef(ctx)
  const changes: RawChange[] = []
  // Collect via a side-effect accumulator rather than git.walk's reduced
  // return value, which is not a reliable flat list across versions.
  await git.walk({
    fs: ctx.fs,
    dir: ctx.dir,
    gitdir: ctx.gitdir,
    trees: marker ? [TREE({ ref: ctx.ref }), WORKDIR()] : [WORKDIR()],
    map: async (filepath, entries) => {
      if (filepath === '.') return undefined
      const head = marker ? entries[0] : null
      const workdir = marker ? entries[1] : entries[0]
      const headType = head ? await head.type() : undefined
      const workdirType = workdir ? await workdir.type() : undefined
      if (headType === 'tree' || workdirType === 'tree') return undefined
      if (isIgnored(filepath)) return undefined
      const headOid = head ? ((await head.oid()) ?? null) : null
      let workdirOid: string | null = null
      if (workdir) {
        const bytes = (await ctx.fs.promises.readFile(
          join(ctx.dir, filepath),
        )) as Uint8Array
        workdirOid = await hashBytes(bytes)
      }
      if (headOid !== workdirOid) {
        changes.push({ path: filepath, headOid, workdirOid })
      }
      return undefined
    },
  })
  return changes
}

/** Read a file's bytes + blob oid from the marker commit, or null if absent. */
export async function readMarkerBlob(
  ctx: GitCtx,
  filepath: string,
): Promise<{ blob: Uint8Array; oid: string } | null> {
  const commit = await resolveRef(ctx)
  if (!commit) return null
  try {
    const { blob, oid } = await git.readBlob({
      fs: ctx.fs,
      gitdir: ctx.gitdir,
      oid: commit,
      filepath,
    })
    return { blob, oid }
  } catch {
    return null
  }
}

/** Stage a path (add/update its blob and index entry). */
export async function add(ctx: GitCtx, filepath: string): Promise<void> {
  await git.add({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath })
}

/** Unstage/remove a path from the index. Safe if the path is untracked. */
export async function remove(ctx: GitCtx, filepath: string): Promise<void> {
  try {
    await git.remove({ fs: ctx.fs, dir: ctx.dir, gitdir: ctx.gitdir, filepath })
  } catch {
    // path was never tracked — nothing to remove
  }
}

/** Commit the current index, advancing the marker. Returns the new oid. */
export async function commit(
  ctx: GitCtx,
  author: Author,
  message: string,
): Promise<string> {
  return git.commit({
    fs: ctx.fs,
    dir: ctx.dir,
    gitdir: ctx.gitdir,
    message,
    author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
  })
}

/** Write a lightweight tag at the current marker commit. */
export async function writeTag(ctx: GitCtx, name: string): Promise<void> {
  const oid = await resolveRef(ctx)
  if (!oid) throw new Error('cannot tag: marker has no commit')
  await writeRef(ctx, `refs/tags/${name}`, oid)
}

/** Point an arbitrary ref at a commit oid (force). */
export async function writeRef(
  ctx: GitCtx,
  ref: string,
  oid: string,
): Promise<void> {
  await git.writeRef({
    fs: ctx.fs,
    gitdir: ctx.gitdir,
    ref,
    value: oid,
    force: true,
  })
}

/**
 * Commit the current index as a commit with an explicit `parent`, **without**
 * advancing the baseline marker. Returns the new commit oid (so the caller can
 * point a side ref at it — e.g. a checkpoint). The tree is built from the index,
 * so callers must stage the working tree first.
 */
export async function commitIndex(
  ctx: GitCtx,
  author: Author,
  message: string,
  parent: string[],
): Promise<string> {
  return git.commit({
    fs: ctx.fs,
    dir: ctx.dir,
    gitdir: ctx.gitdir,
    message,
    author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
    parent,
    ref: ctx.ref,
    noUpdateBranch: true,
  })
}

/**
 * Commit a pre-existing `tree` oid onto the marker (advancing it), with an
 * explicit `parent`. Used by bless to set the baseline to a snapshot's tree
 * without touching the working tree or relying on the index. Returns the oid.
 */
export async function commitTree(
  ctx: GitCtx,
  author: Author,
  message: string,
  tree: string,
  parent: string[],
): Promise<string> {
  return git.commit({
    fs: ctx.fs,
    dir: ctx.dir,
    gitdir: ctx.gitdir,
    message,
    author: { ...author, timestamp: Math.floor(Date.now() / 1000) },
    tree,
    parent,
  })
}

/** The tree oid recorded by a commit. */
export async function readTreeOid(ctx: GitCtx, oid: string): Promise<string> {
  const { commit } = await git.readCommit({
    fs: ctx.fs,
    gitdir: ctx.gitdir,
    oid,
  })
  return commit.tree
}

/** The committer timestamp of a commit, as an ISO-8601 string. */
export async function readCommitTime(
  ctx: GitCtx,
  oid: string,
): Promise<string> {
  const { commit } = await git.readCommit({
    fs: ctx.fs,
    gitdir: ctx.gitdir,
    oid,
  })
  return new Date(commit.committer.timestamp * 1000).toISOString()
}
