// Mobile end-to-end spike: run the real engine over the EXACT mobile storage
// split — the working tree on the Obsidian vault adapter (via `createAdapterFs`)
// and the device-local object store on IndexedDB (via LightningFS) — composed by
// `createRoutingFs`. The desktop path (node:fs for both) and the gitdir-only
// spike are covered elsewhere; this proves the worktree-adapter half drives the
// engine through onboard → edit → bless → revert, exercising the adapter-fs
// mkdirp/readdir/stat/byte round-trip against a faithful in-memory adapter.
import 'fake-indexeddb/auto'
import LightningFS from '@isomorphic-git/lightning-fs'
import { createRoutingFs, ReviewEngine } from '@obsidian-guardian/engine'
import type { DataAdapter, ListedFiles, Stat } from 'obsidian'
import { describe, expect, it } from 'vitest'
import { createAdapterFs } from '../src/adapter-fs'

/** The fs-backend shape `createRoutingFs` expects (PromiseFsClient), derived
 * without importing isomorphic-git (a transitive, not direct, plugin dep). */
type FsBackend = Parameters<typeof createRoutingFs>[0]['gitDirFs']

/**
 * In-memory {@link DataAdapter} with Obsidian's vault-relative, normalised path
 * semantics. mkdir/rmdir/remove are faithful enough to drive the engine; the
 * adapter-fs is what enforces the node-style mkdir contract on top.
 */
function memAdapter(): DataAdapter {
  // Byte-backed like a real vault on disk: read() and readBinary() are two views
  // of the same bytes, so a note written as text reads back as bytes (which is
  // exactly how iso-git hashes the worktree).
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>([''])
  const parent = (p: string): string =>
    p.slice(0, Math.max(0, p.lastIndexOf('/')))
  const t = 1_700_000_000_000
  return {
    getName: () => 'mem',
    async exists(p: string) {
      const k = p === '/' ? '' : p
      return files.has(k) || dirs.has(k)
    },
    async stat(p: string): Promise<Stat | null> {
      const k = p === '/' ? '' : p
      const bytes = files.get(k)
      if (bytes) return { type: 'file', ctime: t, mtime: t, size: bytes.length }
      if (dirs.has(k)) return { type: 'folder', ctime: t, mtime: t, size: 0 }
      return null
    },
    async list(p: string): Promise<ListedFiles> {
      const dir = p === '/' ? '' : p
      const out: ListedFiles = { files: [], folders: [] }
      for (const f of files.keys()) if (parent(f) === dir) out.files.push(f)
      for (const d of dirs)
        if (d !== '' && parent(d) === dir) out.folders.push(d)
      return out
    },
    async read(p: string) {
      const v = files.get(p)
      if (!v) throw new Error(`not found: ${p}`)
      return new TextDecoder().decode(v)
    },
    async readBinary(p: string) {
      const v = files.get(p)
      if (!v) throw new Error(`not found: ${p}`)
      return v.buffer.slice(
        v.byteOffset,
        v.byteOffset + v.byteLength,
      ) as ArrayBuffer
    },
    async write(p: string, data: string) {
      files.set(p, new TextEncoder().encode(data))
    },
    async writeBinary(p: string, data: ArrayBuffer) {
      files.set(p, new Uint8Array(data))
    },
    async mkdir(p: string) {
      dirs.add(p)
    },
    async rmdir(p: string) {
      dirs.delete(p)
    },
    async remove(p: string) {
      files.delete(p)
    },
  } as unknown as DataAdapter
}

let dbCounter = 0

function spikeEngine(): { engine: ReviewEngine; adapter: DataAdapter } {
  const adapter = memAdapter()
  const base = '/vault'
  const gitDir = '/git'
  const workTreeFs = createAdapterFs({ adapter, base }) as unknown as FsBackend
  const gitDirFs = new LightningFS(
    `og-mobile-spike-${dbCounter++}`,
  ) as unknown as FsBackend
  const fs = createRoutingFs({ gitDir, gitDirFs, workTreeFs })
  const engine = new ReviewEngine({ fs, vaultPath: base, gitDir })
  return { engine, adapter }
}

/** Write a vault file the way Obsidian would — at a vault-relative path. */
async function vaultWrite(
  adapter: DataAdapter,
  path: string,
  data: string,
): Promise<void> {
  await adapter.write(path, data)
}

describe('mobile spike: worktree on the vault adapter + gitdir on IndexedDB', () => {
  it('onboards, detects an edit, blesses, and stays clean', async () => {
    const { engine, adapter } = spikeEngine()
    await engine.onboard()
    expect((await engine.status()).clean).toBe(true)

    await vaultWrite(adapter, 'note.md', 'hello from the vault adapter\n')
    const dirty = await engine.status()
    expect(dirty.clean).toBe(false)
    expect(dirty.changes.map((c) => c.path)).toContain('note.md')

    await engine.bless()
    expect((await engine.status()).clean).toBe(true)
  })

  it('reverts a file from the IndexedDB baseline back into the vault adapter', async () => {
    const { engine, adapter } = spikeEngine()
    await engine.onboard()
    const blessed = 'blessed bytes — keep me\n'
    await vaultWrite(adapter, 'doc.md', blessed)
    await engine.bless()
    expect((await engine.status()).clean).toBe(true)

    await vaultWrite(adapter, 'doc.md', 'local scribble, discard\n')
    expect((await engine.status()).clean).toBe(false)

    await engine.revert('doc.md')
    expect(await adapter.read('doc.md')).toBe(blessed)
    expect((await engine.status()).clean).toBe(true)
  })

  it('publishes synced signal files into the vault adapter on bless', async () => {
    const { engine, adapter } = spikeEngine()
    await engine.onboard()
    await vaultWrite(adapter, 'a.md', 'one\n')
    await engine.bless()
    // bless writes device-<id>.json + bless-<id>.json under _OG/sync/ — created
    // through the adapter-fs (exercising its mkdirp + write).
    const sync = await adapter.list('_OG/sync')
    expect(sync.files.some((f) => /bless-.*\.json$/.test(f))).toBe(true)
    expect(sync.files.some((f) => /device-.*\.json$/.test(f))).toBe(true)
  })
})
