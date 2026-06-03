import type { DataAdapter, Stat } from 'obsidian'

/**
 * Wrap Obsidian's vault {@link DataAdapter} as the `fs.promises` surface the
 * engine (and isomorphic-git through it) needs for the **working tree** on
 * mobile, where there is no Node `fs`. It is the worktree half of the mobile
 * split — the gitdir half is a separate IndexedDB-backed fs — composed by
 * `createRoutingFs`.
 *
 * Path model: the engine addresses worktree files as absolute paths under
 * `vaultPath` (it joins `vaultPath` + a vault-relative path). The adapter speaks
 * **vault-relative**, normalised paths, so every call here strips the `base`
 * (= `vaultPath`) prefix and normalises before delegating. Paths never under
 * `base` are a routing bug (the router only sends us non-gitdir paths) and throw.
 *
 * Type-only obsidian import (erased at build) + a local normaliser keep this
 * unit-testable against a fake adapter, with no obsidian runtime dependency.
 */
export interface AdapterFsOptions {
  adapter: DataAdapter
  /** Absolute worktree root the engine prefixes (its `vaultPath`). */
  base: string
}

/** The `.promises` shape isomorphic-git consumes (matches `createRoutingFs`). */
type AnyFn = (...args: unknown[]) => unknown

/** A node-ish error carrying a `code` so callers' `catch`/ENOENT checks work. */
function fsError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}

/** Collapse slashes and trim leading/trailing ones (Obsidian `normalizePath`
 * semantics for our already-well-formed inputs); '' means the vault root. */
function normalize(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** A Uint8Array/Buffer/ArrayBuffer → ArrayBuffer (for `writeBinary`). */
function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer
  }
  throw fsError('EINVAL', 'writeFile expected string or bytes')
}

/** True for a `utf8`/`utf-8` encoding option (string or `{ encoding }`). */
function wantsText(options: unknown): boolean {
  const enc =
    typeof options === 'string'
      ? options
      : ((options as { encoding?: string } | undefined)?.encoding ?? null)
  return enc === 'utf8' || enc === 'utf-8'
}

export function createAdapterFs(options: AdapterFsOptions): {
  promises: Record<string, AnyFn>
} {
  const { adapter, base } = options
  const baseNorm = normalize(base)

  /** Absolute engine path → normalised vault-relative path. */
  const rel = (abs: unknown): string => {
    if (typeof abs !== 'string')
      throw fsError('EINVAL', 'path must be a string')
    const p = normalize(abs)
    if (baseNorm === '') return p
    if (p === baseNorm) return ''
    if (p.startsWith(`${baseNorm}/`)) return p.slice(baseNorm.length + 1)
    throw fsError('EINVAL', `path ${abs} is outside the worktree base ${base}`)
  }

  /** The `<dir>/<name>` ListedFiles entries → bare names (readdir contract). */
  const baseName = (p: string): string => {
    const n = normalize(p)
    const slash = n.lastIndexOf('/')
    return slash === -1 ? n : n.slice(slash + 1)
  }

  const toStats = (stat: Stat): Record<string, unknown> => {
    const isDir = stat.type === 'folder'
    return {
      type: isDir ? 'dir' : 'file',
      mode: isDir ? 0o040000 : 0o100644,
      size: stat.size,
      ino: 0,
      mtimeMs: stat.mtime,
      ctimeMs: stat.ctime,
      uid: 1,
      gid: 1,
      dev: 1,
      isFile: () => !isDir,
      isDirectory: () => isDir,
      isSymbolicLink: () => false,
    }
  }

  const statPath = async (path: unknown): Promise<Record<string, unknown>> => {
    const r = rel(path)
    const stat = await adapter.stat(r === '' ? '/' : r)
    if (!stat) throw fsError('ENOENT', `no such file or directory, stat '${r}'`)
    return toStats(stat)
  }

  const promises: Record<string, AnyFn> = {
    readFile: async (path: unknown, options?: unknown): Promise<unknown> => {
      const r = rel(path)
      if (!(await adapter.exists(r))) {
        throw fsError('ENOENT', `no such file or directory, open '${r}'`)
      }
      if (wantsText(options)) return adapter.read(r)
      return Buffer.from(await adapter.readBinary(r))
    },
    writeFile: async (
      path: unknown,
      data: unknown,
      options?: unknown,
    ): Promise<void> => {
      const r = rel(path)
      if (typeof data === 'string' || wantsText(options)) {
        await adapter.write(r, String(data))
        return
      }
      await adapter.writeBinary(r, toArrayBuffer(data))
    },
    unlink: async (path: unknown): Promise<void> => {
      await adapter.remove(rel(path))
    },
    readdir: async (path: unknown): Promise<string[]> => {
      const r = rel(path)
      const listed = await adapter.list(r === '' ? '/' : r)
      return [...listed.files, ...listed.folders].map(baseName)
    },
    mkdir: async (path: unknown): Promise<void> => {
      const r = rel(path)
      // Behave like node:fs's non-recursive mkdir — throw EEXIST / ENOENT with
      // codes — so the engine's `ensureDir` mkdirp works the same here as on
      // node:fs and LightningFS, independent of the real adapter's own
      // parent-creation quirks (we create parents ourselves via ENOENT).
      if (r === '') throw fsError('EEXIST', 'mkdir: the vault root exists')
      if (await adapter.exists(r)) {
        throw fsError('EEXIST', `mkdir: '${r}' already exists`)
      }
      const slash = r.lastIndexOf('/')
      const parent = slash === -1 ? '' : r.slice(0, slash)
      if (parent !== '' && !(await adapter.exists(parent))) {
        throw fsError('ENOENT', `mkdir: parent of '${r}' is missing`)
      }
      await adapter.mkdir(r)
    },
    rmdir: async (path: unknown): Promise<void> => {
      await adapter.rmdir(rel(path), false)
    },
    stat: statPath,
    lstat: statPath,
    // The worktree has no symlinks; the engine never makes them, but the fs
    // contract must answer. readlink is reached only after a symlink lstat,
    // which never reports one, so throwing here is unreachable in practice.
    symlink: async (): Promise<void> => {
      throw fsError('ENOTSUP', 'symlink is not supported on the vault adapter')
    },
    readlink: async (): Promise<never> => {
      throw fsError('ENOTSUP', 'readlink is not supported on the vault adapter')
    },
    chmod: async (): Promise<void> => {
      // No file modes in the vault; isomorphic-git tolerates a no-op chmod.
    },
  }

  return { promises }
}
