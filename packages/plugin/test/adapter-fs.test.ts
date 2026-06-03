import type { DataAdapter, ListedFiles, Stat } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { createAdapterFs } from '../src/adapter-fs'

/**
 * A minimal in-memory {@link DataAdapter} mimicking the subset the adapter-fs
 * uses, with Obsidian's vault-relative, normalised path semantics. Lets us drive
 * the adapter-fs without a real Obsidian (the LightningFS spike does the same for
 * the gitdir half).
 */
function fakeAdapter(): DataAdapter {
  const files = new Map<string, string | ArrayBuffer>()
  const dirs = new Set<string>([''])
  const parent = (p: string): string =>
    p.slice(0, Math.max(0, p.lastIndexOf('/')))
  const now = 1_700_000_000_000
  const a = {
    getName: () => 'fake',
    async exists(path: string) {
      const p = path === '/' ? '' : path
      return files.has(p) || dirs.has(p)
    },
    async stat(path: string): Promise<Stat | null> {
      const p = path === '/' ? '' : path
      if (files.has(p)) {
        const v = files.get(p)
        const size =
          typeof v === 'string' ? v.length : (v as ArrayBuffer).byteLength
        return { type: 'file', ctime: now, mtime: now, size }
      }
      if (dirs.has(p))
        return { type: 'folder', ctime: now, mtime: now, size: 0 }
      return null
    },
    async list(path: string): Promise<ListedFiles> {
      const dir = path === '/' ? '' : path
      const out: ListedFiles = { files: [], folders: [] }
      for (const f of files.keys()) if (parent(f) === dir) out.files.push(f)
      for (const d of dirs)
        if (d !== '' && parent(d) === dir) out.folders.push(d)
      return out
    },
    async read(path: string) {
      const v = files.get(path)
      if (typeof v !== 'string') throw new Error(`not a text file: ${path}`)
      return v
    },
    async readBinary(path: string) {
      const v = files.get(path)
      if (!(v instanceof ArrayBuffer)) throw new Error(`not binary: ${path}`)
      return v
    },
    async write(path: string, data: string) {
      files.set(path, data)
    },
    async writeBinary(path: string, data: ArrayBuffer) {
      files.set(path, data)
    },
    async mkdir(path: string) {
      dirs.add(path)
    },
    async rmdir(path: string) {
      dirs.delete(path)
    },
    async remove(path: string) {
      files.delete(path)
    },
  }
  return a as unknown as DataAdapter
}

/** Finite-key promises shape so calls aren't `possibly undefined` under
 * `noUncheckedIndexedAccess` (the runtime object has all of these). */
type FsPromises = Record<
  | 'readFile'
  | 'writeFile'
  | 'unlink'
  | 'readdir'
  | 'mkdir'
  | 'rmdir'
  | 'stat'
  | 'lstat'
  | 'symlink'
  | 'readlink'
  | 'chmod',
  (...args: unknown[]) => Promise<unknown>
>

describe('createAdapterFs', () => {
  const base = '/vault'
  const make = (): { fs: { promises: FsPromises }; adapter: DataAdapter } => {
    const adapter = fakeAdapter()
    return {
      fs: createAdapterFs({ adapter, base }) as unknown as {
        promises: FsPromises
      },
      adapter,
    }
  }

  it('round-trips a utf8 file under the base, stripping the prefix', async () => {
    const { fs, adapter } = make()
    await fs.promises.writeFile('/vault/notes/a.md', 'hello\n', 'utf8')
    // Stored at the vault-relative path, not the absolute engine path.
    expect(await adapter.exists('notes/a.md')).toBe(true)
    expect(await adapter.exists('/vault/notes/a.md')).toBe(false)
    expect(await fs.promises.readFile('/vault/notes/a.md', 'utf8')).toBe(
      'hello\n',
    )
  })

  it('round-trips binary bytes exactly', async () => {
    const { fs } = make()
    const bytes = Uint8Array.from([0, 1, 2, 250, 255])
    await fs.promises.writeFile('/vault/blob.bin', bytes)
    const back = (await fs.promises.readFile('/vault/blob.bin')) as Uint8Array
    expect(Array.from(back)).toEqual([0, 1, 2, 250, 255])
  })

  it('throws ENOENT for a missing file', async () => {
    const { fs } = make()
    await expect(
      fs.promises.readFile('/vault/missing.md', 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.promises.stat('/vault/missing.md')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('readdir returns bare names of files and folders', async () => {
    const { fs } = make()
    await fs.promises.mkdir('/vault/dir')
    await fs.promises.writeFile('/vault/dir/x.md', 'x', 'utf8')
    await fs.promises.writeFile('/vault/dir/y.md', 'y', 'utf8')
    await fs.promises.mkdir('/vault/dir/sub')
    const names = ((await fs.promises.readdir('/vault/dir')) as string[]).sort()
    expect(names).toEqual(['sub', 'x.md', 'y.md'])
  })

  it('stat reports file vs directory and lstat mirrors it', async () => {
    const { fs } = make()
    await fs.promises.mkdir('/vault/d')
    await fs.promises.writeFile('/vault/d/f.md', 'hi', 'utf8')
    const fileStat = (await fs.promises.stat('/vault/d/f.md')) as {
      isFile(): boolean
      isDirectory(): boolean
      size: number
    }
    expect(fileStat.isFile()).toBe(true)
    expect(fileStat.isDirectory()).toBe(false)
    expect(fileStat.size).toBe(2)
    const dirStat = (await fs.promises.lstat('/vault/d')) as {
      isDirectory(): boolean
    }
    expect(dirStat.isDirectory()).toBe(true)
  })

  it('mkdir is node-faithful: EEXIST on existing/root, ENOENT on missing parent', async () => {
    const { fs } = make()
    await fs.promises.mkdir('/vault/d')
    // Re-creating an existing dir, or the root, throws EEXIST (ensureDir tolerates it).
    await expect(fs.promises.mkdir('/vault/d')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    await expect(fs.promises.mkdir('/vault')).rejects.toMatchObject({
      code: 'EEXIST',
    })
    // A missing parent throws ENOENT (ensureDir recurses to create it).
    await expect(fs.promises.mkdir('/vault/a/b/c')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('unlink removes a file', async () => {
    const { fs, adapter } = make()
    await fs.promises.writeFile('/vault/gone.md', 'x', 'utf8')
    await fs.promises.unlink('/vault/gone.md')
    expect(await adapter.exists('gone.md')).toBe(false)
  })

  it('rejects a path outside the worktree base', async () => {
    const { fs } = make()
    await expect(
      fs.promises.readFile('/elsewhere/x.md', 'utf8'),
    ).rejects.toMatchObject({ code: 'EINVAL' })
  })

  it('symlink/readlink are unsupported', async () => {
    const { fs } = make()
    await expect(fs.promises.symlink('a', 'b')).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
    await expect(fs.promises.readlink('/vault/x')).rejects.toMatchObject({
      code: 'ENOTSUP',
    })
  })
})
