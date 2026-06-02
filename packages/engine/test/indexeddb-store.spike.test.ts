// Mobile spike: prove the engine runs with its device-local object store on
// IndexedDB (via LightningFS) and the working tree on node:fs, composed by the
// path-routing fs — the exact split a mobile (Android/iOS) plugin will use. The
// gitdir never touches node:fs here; only the content Hash must agree, which is
// what lets mobile skip a real git folder entirely. fake-indexeddb supplies the
// IndexedDB globals LightningFS needs in Node.
import 'fake-indexeddb/auto'
import * as nodeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LightningFS from '@isomorphic-git/lightning-fs'
import {
  createRoutingFs,
  type EngineConfig,
  ReviewEngine,
} from '@obsidian-guardian/engine'
import type { PromiseFsClient } from 'isomorphic-git'
import { afterEach, describe, expect, it } from 'vitest'

const tmpRoots: string[] = []
let dbCounter = 0

afterEach(async () => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

async function spikeEngine(): Promise<{
  engine: ReviewEngine
  vault: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'guardian-idb-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  // gitDir is a virtual path inside LightningFS, never on disk.
  const gitDir = '/og-gitdir'
  await mkdir(vault, { recursive: true })

  // Fresh IndexedDB-backed store per test (unique db name) to avoid cross-talk.
  const lfs = new LightningFS(`og-spike-${dbCounter++}`)
  const fs = createRoutingFs({
    gitDir,
    gitDirFs: lfs as unknown as PromiseFsClient,
    workTreeFs: nodeFs,
  })
  const config: EngineConfig = { fs, vaultPath: vault, gitDir }
  const engine = new ReviewEngine(config)
  return { engine, vault }
}

describe('mobile spike: object store on IndexedDB (LightningFS)', () => {
  it('onboards, detects an edit, and blesses with the gitdir in IndexedDB', async () => {
    const { engine, vault } = await spikeEngine()
    await engine.onboard()
    expect((await engine.status()).clean).toBe(true)

    await writeFile(join(vault, 'note.md'), 'hello from mobile\n')
    const dirty = await engine.status()
    expect(dirty.clean).toBe(false)
    expect(dirty.changes.map((c) => c.path)).toContain('note.md')

    await engine.bless()
    expect((await engine.status()).clean).toBe(true)
  })

  it('round-trips blob bytes through the IndexedDB store (revert from baseline)', async () => {
    // The real IDB risk isn't the blob sha (a pure function of bytes) — it's
    // whether IndexedDB stores and reads back the exact bytes. Bless writes the
    // blob into the IDB store; revert reads it back out of the baseline tree.
    const { engine, vault } = await spikeEngine()
    await engine.onboard()
    const blessed = 'blessed content — keep me\n'
    await writeFile(join(vault, 'doc.md'), blessed)
    await engine.bless()
    expect((await engine.status()).clean).toBe(true)

    // Diverge the working tree, then revert: the bytes must come back from IDB.
    await writeFile(join(vault, 'doc.md'), 'local scribble, discard\n')
    expect((await engine.status()).clean).toBe(false)
    await engine.revert('doc.md')

    const restored = await readFile(join(vault, 'doc.md'), 'utf8')
    expect(restored).toBe(blessed)
    expect((await engine.status()).clean).toBe(true)
  })
})
