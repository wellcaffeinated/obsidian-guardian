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
