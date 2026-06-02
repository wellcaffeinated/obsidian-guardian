import * as nodeFs from 'node:fs'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ReviewEngine } from '@obsidian-guardian/engine'
import { afterEach, describe, expect, it } from 'vitest'

const tmpRoots: string[] = []

afterEach(async () => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

async function write(vault: string, rel: string, content: string): Promise<void> {
  const file = join(vault, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

/** A device = its own working tree (a synced copy) + its own non-synced gitDir. */
async function device(
  seed: Record<string, string> = {},
): Promise<{ engine: ReviewEngine; vault: string }> {
  const root = await mkdtemp(join(tmpdir(), 'guardian-coord-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  await mkdir(vault, { recursive: true })
  for (const [rel, content] of Object.entries(seed)) await write(vault, rel, content)
  const engine = new ReviewEngine({
    fs: nodeFs,
    vaultPath: vault,
    gitDir: join(root, 'gitdb'),
  })
  await engine.onboard()
  return { engine, vault }
}

describe('bless — delta manifest', () => {
  it('emits absolute hashes + DELETED tombstones for changed paths only', async () => {
    const { engine, vault } = await device({ 'a.md': 'a0\n', 'b.md': 'b0\n' })
    await write(vault, 'a.md', 'a1\n') // modify
    await write(vault, 'c.md', 'c0\n') // add
    await unlink(join(vault, 'b.md')) // delete
    const rec = await engine.bless()
    const byPath = Object.fromEntries(rec.manifest.map((e) => [e.path, e.hash]))
    expect(Object.keys(byPath).sort()).toEqual(['a.md', 'b.md', 'c.md'])
    expect(byPath['b.md']).toBe('DELETED')
    expect(byPath['a.md']).toMatch(/^[0-9a-f]{40}$/)
    expect(rec.seq).toBe(1)
    expect((await engine.status()).clean).toBe(true) // own baseline advanced
  })

  it('increments bless seq across calls (persisted)', async () => {
    const { engine, vault } = await device({ 'a.md': 'a0\n' })
    await write(vault, 'a.md', 'a1\n')
    expect((await engine.bless()).seq).toBe(1)
    await write(vault, 'a.md', 'a2\n')
    expect((await engine.bless()).seq).toBe(2)
  })
})

describe('applyBless — content gate', () => {
  it('admits a peer bless when local bytes already match (post-sync)', async () => {
    const a = await device({ 'note.md': 'v0\n' })
    const b = await device({ 'note.md': 'v0\n' })
    // A edits + blesses v1; sync converges B's working tree to v1.
    await write(a.vault, 'note.md', 'v1\n')
    const rec = await a.engine.bless()
    await write(b.vault, 'note.md', 'v1\n')
    const res = await b.engine.applyBless(rec)
    expect(res).toEqual({ changed: true, stillPending: false })
    expect((await b.engine.status()).clean).toBe(true)
  })

  it('defers (arrival gate) when the blessed bytes have not synced in yet', async () => {
    const a = await device({ 'note.md': 'v0\n' })
    const b = await device({ 'note.md': 'v0\n' })
    await write(a.vault, 'note.md', 'v1\n')
    const rec = await a.engine.bless()
    // B has NOT received v1 yet → gate fails → no baseline move, retain the
    // bless obligation. B's working tree still equals its baseline (v0), so
    // status itself is clean — the obligation lives in LocalState, not status.
    const res = await b.engine.applyBless(rec)
    expect(res).toEqual({ changed: false, stillPending: true })
    expect((await b.engine.status()).clean).toBe(true)
    // Once v1 syncs in, it shows as pending; a retry of the bless admits it.
    await write(b.vault, 'note.md', 'v1\n')
    expect((await b.engine.status()).clean).toBe(false)
    expect(await b.engine.applyBless(rec)).toEqual({
      changed: true,
      stillPending: false,
    })
    expect((await b.engine.status()).clean).toBe(true)
  })

  it('causal cut: a newer local edit is not regressed by an older bless', async () => {
    const a = await device({ 'note.md': 'v0\n' })
    const b = await device({ 'note.md': 'v0\n' })
    await write(a.vault, 'note.md', 'v1\n')
    const rec = await a.engine.bless()
    // B already moved on to v2 locally; the v1 bless must not match.
    await write(b.vault, 'note.md', 'v2\n')
    const res = await b.engine.applyBless(rec)
    expect(res.changed).toBe(false)
    expect(res.stillPending).toBe(true)
    expect((await b.engine.status()).clean).toBe(false) // v2 stays pending
  })

  it('is idempotent — re-applying a matching bless does nothing', async () => {
    const a = await device({ 'note.md': 'v0\n' })
    const b = await device({ 'note.md': 'v0\n' })
    await write(a.vault, 'note.md', 'v1\n')
    const rec = await a.engine.bless()
    await write(b.vault, 'note.md', 'v1\n')
    expect((await b.engine.applyBless(rec)).changed).toBe(true)
    expect((await b.engine.applyBless(rec)).changed).toBe(false)
  })

  it('partial apply: matching paths admit, the rest stay pending', async () => {
    const a = await device({ 'x.md': 'x0\n', 'y.md': 'y0\n' })
    const b = await device({ 'x.md': 'x0\n', 'y.md': 'y0\n' })
    await write(a.vault, 'x.md', 'x1\n')
    await write(a.vault, 'y.md', 'y1\n')
    const rec = await a.engine.bless()
    // Only x synced to B.
    await write(b.vault, 'x.md', 'x1\n')
    const res = await b.engine.applyBless(rec)
    expect(res).toEqual({ changed: true, stillPending: true })
    // x admitted (baseline now x1, matching the working tree); y stayed y0 in
    // both baseline and working tree ⇒ status clean. y's bless obligation
    // persists for when y1 eventually syncs in.
    expect((await b.engine.status()).clean).toBe(true)
    await write(b.vault, 'y.md', 'y1\n')
    expect((await b.engine.status()).changes.map((c) => c.path)).toEqual([
      'y.md',
    ])
    expect(await b.engine.applyBless(rec)).toEqual({
      changed: true,
      stillPending: false,
    })
  })

  it('DELETED tombstone: admits only once the path is gone locally', async () => {
    const a = await device({ 'gone.md': 'g\n', 'keep.md': 'k\n' })
    const b = await device({ 'gone.md': 'g\n', 'keep.md': 'k\n' })
    await unlink(join(a.vault, 'gone.md'))
    const rec = await a.engine.bless()
    // B still has the file → tombstone gated.
    expect(await b.engine.applyBless(rec)).toEqual({
      changed: false,
      stillPending: true,
    })
    // Deletion syncs to B → tombstone admits.
    await unlink(join(b.vault, 'gone.md'))
    expect(await b.engine.applyBless(rec)).toEqual({
      changed: true,
      stillPending: false,
    })
    expect((await b.engine.status()).clean).toBe(true)
  })

  it('converges: same working tree + same bless ⇒ same blessed state', async () => {
    const a = await device({ 'note.md': 'v0\n' })
    const b = await device({ 'note.md': 'v0\n' })
    await write(a.vault, 'note.md', 'v1\n')
    const rec = await a.engine.bless()
    await write(b.vault, 'note.md', 'v1\n')
    await b.engine.applyBless(rec)
    // Both trust v1 with nothing pending; B's marker advanced independently.
    expect((await a.engine.status()).clean).toBe(true)
    expect((await b.engine.status()).clean).toBe(true)
    expect((await b.engine.status()).marker).not.toBeNull()
  })
})
