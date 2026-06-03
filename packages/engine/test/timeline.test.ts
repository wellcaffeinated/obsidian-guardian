import * as nodeFs from 'node:fs'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type EngineConfig, ReviewEngine } from '@obsidian-guardian/engine'
import { afterEach, describe, expect, it } from 'vitest'

const tmpRoots: string[] = []

afterEach(async () => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

async function write(
  vault: string,
  rel: string,
  content: string,
): Promise<void> {
  const file = join(vault, rel)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function freshEngine(
  baseline: Record<string, string> = {},
  config: Partial<EngineConfig> = {},
): Promise<{ engine: ReviewEngine; vault: string }> {
  const root = await mkdtemp(join(tmpdir(), 'guardian-tl-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  const gitdir = join(root, 'gitdb')
  await mkdir(vault, { recursive: true })
  for (const [rel, content] of Object.entries(baseline)) {
    await write(vault, rel, content)
  }
  const engine = new ReviewEngine({
    fs: nodeFs,
    vaultPath: vault,
    gitDir: gitdir,
    ...config,
  })
  await engine.onboard()
  return { engine, vault }
}

describe('listCheckpoints', () => {
  it('is empty before any checkpoint', async () => {
    const { engine } = await freshEngine({ 'a.md': 'one\n' })
    expect(await engine.listCheckpoints()).toEqual([])
  })

  it('does not create a duplicate checkpoint when clicked again with no edits', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    const first = await engine.checkpoint()
    expect(first.created).toBe(true)
    // No edits since → the working tree still equals the latest checkpoint.
    const again = await engine.checkpoint()
    expect(again.created).toBe(false)
    expect(again.oid).toBe(first.oid)
    expect(await engine.listCheckpoints()).toHaveLength(1)
  })

  it('a fresh checkpoint has an empty diff to the current working tree', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    await engine.checkpoint()
    const tl = await engine.timeline()
    expect(tl.checkpoints).toHaveLength(1)
    expect(tl.checkpoints[0]?.changes).toEqual([])
  })

  it('lists created checkpoints newest seq first', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    const first = await engine.checkpoint()
    await write(vault, 'a.md', 'three\n')
    const second = await engine.checkpoint()

    const list = await engine.listCheckpoints()
    expect(list.map((c) => c.seq)).toEqual([second.seq, first.seq])
    expect(list[0]?.oid).toBe(second.oid)
    expect(list[1]?.oid).toBe(first.oid)
    for (const cp of list) expect(typeof cp.when).toBe('string')
  })
})

describe('timeline', () => {
  it('reports the baseline, current diff, and per-checkpoint diffs', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    const cp = await engine.checkpoint()
    // Move past the checkpoint so current differs from both baseline & checkpoint.
    await write(vault, 'a.md', 'three\n')
    await write(vault, 'b.md', 'new\n')

    const tl = await engine.timeline()
    expect(tl.baseline.oid).not.toBeNull()
    expect(tl.baseline.when).toBeTypeOf('string')

    // current = baseline → working tree: a.md modified, b.md added.
    expect(tl.current.map((c) => `${c.kind} ${c.path}`).sort()).toEqual([
      'add b.md',
      'modify a.md',
    ])

    // one checkpoint, diff checkpoint → working tree (a.md modified, b.md added).
    expect(tl.checkpoints).toHaveLength(1)
    const entry = tl.checkpoints[0]
    expect(entry?.oid).toBe(cp.oid)
    expect(entry?.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual([
      'add b.md',
      'modify a.md',
    ])
  })
})

describe('incremental work-index (touch / rescan)', () => {
  it('touch() makes status match a full scan after a direct edit', async () => {
    const { engine, vault } = await freshEngine({
      'a.md': 'one\n',
      'b.md': 'b\n',
    })
    // Prime the index via a first touch, then edit + touch only the changed path.
    await write(vault, 'a.md', 'two\n')
    await engine.touch('a.md')
    const s = await engine.status()
    expect(s.clean).toBe(false)
    expect(s.changes.map((c) => `${c.kind} ${c.path}`)).toEqual(['modify a.md'])
  })

  it('touch() tracks adds and deletes', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'c.md', 'new\n')
    await engine.touch('c.md') // primes + records the add
    await unlink(join(vault, 'a.md'))
    await engine.touch('a.md') // records the delete
    const s = await engine.status()
    expect(s.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual([
      'add c.md',
      'delete a.md',
    ])
  })

  it('a primed index ignores out-of-band writes until rescan() reconciles', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await engine.touch('a.md') // prime the index (a.md = one)
    // Direct disk write that bypasses touch(): the index is intentionally stale.
    await write(vault, 'a.md', 'two\n')
    expect((await engine.status()).clean).toBe(true) // stale index, by contract
    await engine.rescan()
    const s = await engine.status()
    expect(s.clean).toBe(false)
    expect(s.changes.map((c) => c.path)).toEqual(['a.md'])
  })

  it('checkpoint diffs use the primed index too', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    await engine.touch('a.md')
    const cp = await engine.checkpoint()
    await write(vault, 'a.md', 'three\n')
    await engine.touch('a.md')
    const tl = await engine.timeline()
    expect(tl.checkpoints[0]?.oid).toBe(cp.oid)
    expect(tl.checkpoints[0]?.changes.map((c) => c.path)).toEqual(['a.md'])
  })

  it('bless() clears pending and re-syncs the index from disk', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    await engine.touch('a.md')
    expect((await engine.status()).clean).toBe(false)
    await engine.bless()
    expect((await engine.status()).clean).toBe(true)
  })
})

describe('fileDiff', () => {
  it('returns signed lines for a modified file (baseline → workdir)', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\ntwo\n' })
    await write(vault, 'a.md', 'one\nTWO\nthree\n')
    const diff = await engine.fileDiff('a.md')
    expect(diff.binary).toBe(false)
    expect(diff.lines).toEqual([
      { sign: ' ', text: 'one' },
      { sign: '-', text: 'two' },
      { sign: '+', text: 'TWO' },
      { sign: '+', text: 'three' },
    ])
  })

  it('diffs against a checkpoint when given its oid', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'one\ntwo\n')
    const cp = await engine.checkpoint()
    await write(vault, 'a.md', 'one\ntwo\nthree\n')
    const diff = await engine.fileDiff('a.md', cp.oid)
    expect(diff.lines).toEqual([
      { sign: ' ', text: 'one' },
      { sign: ' ', text: 'two' },
      { sign: '+', text: 'three' },
    ])
  })

  it('reports an added file as all-additions and an unchanged file as all-context', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'keep\n' })
    await write(vault, 'b.md', 'x\ny\n')
    const add = await engine.fileDiff('b.md')
    expect(add.lines).toEqual([
      { sign: '+', text: 'x' },
      { sign: '+', text: 'y' },
    ])
    const same = await engine.fileDiff('a.md')
    expect(same.lines).toEqual([{ sign: ' ', text: 'keep' }])
  })
})

describe('bless preserves the previous baseline', () => {
  it('leaves a restorable checkpoint of the pre-bless state', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    await engine.bless()

    // The baseline advanced to `two`, and the previous baseline (`one`) is now a
    // checkpoint, so blessing can be undone.
    const cps = await engine.listCheckpoints()
    expect(cps).toHaveLength(1)
    const tl = await engine.timeline()
    // The preserved checkpoint is the previous baseline's tree, not the new one.
    expect(cps[0]?.tree).not.toBe(tl.baseline.tree)

    await engine.restoreCheckpoint(cps[0]?.oid ?? '')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(vault, 'a.md'), 'utf8')).toBe('one\n')
  })

  it('does not create a checkpoint when a bless does not advance the baseline', async () => {
    const { engine } = await freshEngine({ 'a.md': 'one\n' })
    await engine.bless() // nothing pending → baseline unchanged
    expect(await engine.listCheckpoints()).toEqual([])
  })
})

describe('restoreCheckpoint', () => {
  it('resets the working tree to a checkpoint without moving the baseline', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'one\n' })
    await write(vault, 'a.md', 'two\n')
    await write(vault, 'keep.md', 'kept\n')
    const cp = await engine.checkpoint()
    // Diverge from the checkpoint: edit a.md, add c.md, delete keep.md.
    await write(vault, 'a.md', 'three\n')
    await write(vault, 'c.md', 'extra\n')
    await unlink(join(vault, 'keep.md'))

    await engine.restoreCheckpoint(cp.oid)

    // Working tree now equals the checkpoint content.
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(vault, 'a.md'), 'utf8')).toBe('two\n')
    expect(await readFile(join(vault, 'keep.md'), 'utf8')).toBe('kept\n')
    await expect(readFile(join(vault, 'c.md'), 'utf8')).rejects.toThrow()

    // The checkpoint differs from baseline (a.md two vs one, keep.md added),
    // so status against the baseline is NOT clean — the baseline never moved.
    const status = await engine.status()
    expect(status.clean).toBe(false)
    expect(status.changes.map((c) => `${c.kind} ${c.path}`).sort()).toEqual([
      'add keep.md',
      'modify a.md',
    ])
  })
})
