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

/** A flattened tree entry: full vault-relative path → blob oid + git file mode. */
export interface FlatEntry {
  oid: string
  /** Git file mode, e.g. `100644` (regular), `100755` (exec), `120000` (symlink). */
  mode: string
}

/** Git blob oid for arbitrary bytes, WITHOUT storing them (for the content gate). */
export async function hashBlob(bytes: Uint8Array): Promise<string> {
  return hashBytes(bytes)
}

/** Write blob bytes into the object store and return their oid (idempotent). */
export async function writeBlob(
  ctx: GitCtx,
  bytes: Uint8Array,
): Promise<string> {
  return git.writeBlob({ fs: ctx.fs, gitdir: ctx.gitdir, blob: bytes })
}

/**
 * Recursively flatten a tree commit's tree into a `Map<path, FlatEntry>` keyed
 * by full vault-relative path. Sub-trees are descended; only blob leaves land in
 * the map. The inverse of {@link writeFlatTree}.
 */
export async function readFlatTree(
  ctx: GitCtx,
  treeOid: string,
): Promise<Map<string, FlatEntry>> {
  const out = new Map<string, FlatEntry>()
  const descend = async (oid: string, prefix: string): Promise<void> => {
    const { tree } = await git.readTree({ fs: ctx.fs, gitdir: ctx.gitdir, oid })
    for (const entry of tree) {
      const path = prefix ? `${prefix}/${entry.path}` : entry.path
      if (entry.type === 'tree') {
        await descend(entry.oid, path)
      } else if (entry.type === 'blob') {
        out.set(path, { oid: entry.oid, mode: entry.mode })
      }
    }
  }
  await descend(treeOid, '')
  return out
}

/**
 * Build a (possibly nested) git tree from a flat `path → FlatEntry` map and
 * return its tree oid. Sub-directories are materialised as nested tree objects,
 * written depth-first. The inverse of {@link readFlatTree}; the blobs must
 * already exist in the object store (see {@link writeBlob}).
 */
export async function writeFlatTree(
  ctx: GitCtx,
  entries: Map<string, FlatEntry>,
): Promise<string> {
  // Group this level's keys by their first path segment.
  interface Node {
    blobs: Map<string, FlatEntry> // leaf name → entry
    dirs: Map<string, Map<string, FlatEntry>> // dir name → sub-map (relative)
  }
  const build = async (level: Map<string, FlatEntry>): Promise<string> => {
    const node: Node = { blobs: new Map(), dirs: new Map() }
    for (const [path, entry] of level) {
      const slash = path.indexOf('/')
      if (slash === -1) {
        node.blobs.set(path, entry)
      } else {
        const dir = path.slice(0, slash)
        const rest = path.slice(slash + 1)
        let sub = node.dirs.get(dir)
        if (!sub) {
          sub = new Map()
          node.dirs.set(dir, sub)
        }
        sub.set(rest, entry)
      }
    }
    const tree: Array<{
      mode: string
      path: string
      oid: string
      type: 'blob' | 'tree'
    }> = []
    for (const [name, entry] of node.blobs) {
      tree.push({ mode: entry.mode, path: name, oid: entry.oid, type: 'blob' })
    }
    for (const [name, sub] of node.dirs) {
      const oid = await build(sub)
      tree.push({ mode: '040000', path: name, oid, type: 'tree' })
    }
    return git.writeTree({ fs: ctx.fs, gitdir: ctx.gitdir, tree })
  }
  return build(entries)
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
