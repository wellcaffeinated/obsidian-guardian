import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  changesFileName,
  type EngineConfig,
  ReviewEngine,
  renderChangesFile,
  type SnapshotStatus,
} from '@obsidian-guardian/engine'
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
): Promise<{ engine: ReviewEngine; vault: string; gitdir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'guardian-bless-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  const gitdir = join(root, 'gitdb')
  await mkdir(vault, { recursive: true })
  for (const [rel, content] of Object.entries(baseline)) {
    await write(vault, rel, content)
  }
  const engine = new ReviewEngine({
    vaultPath: vault,
    gitDir: gitdir,
    ...config,
  })
  await engine.onboard()
  return { engine, vault, gitdir }
}

describe('checkpoint', () => {
  it('is a no-op when the tree equals the baseline', async () => {
    const { engine } = await freshEngine({ 'note.md': 'v0\n' })
    const cp = await engine.checkpoint()
    expect(cp.created).toBe(false)
    expect(cp.seq).toBe(0) // no seq assigned yet
  })

  it('assigns strictly increasing seq for distinct snapshots', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    await write(vault, 'note.md', 'v1\n')
    const a = await engine.checkpoint()
    await write(vault, 'note.md', 'v2\n')
    const b = await engine.checkpoint()
    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(b.seq).toBeGreaterThan(a.seq)
    expect(a.oid).not.toBe(b.oid)
  })

  it('does not advance the baseline', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    const before = (await engine.status()).marker
    await write(vault, 'note.md', 'v1\n')
    await engine.checkpoint()
    expect((await engine.status()).marker).toBe(before)
    expect((await engine.status()).clean).toBe(false) // still pending
  })
})

describe('blessSnapshot — monotonic seq protocol', () => {
  /** Take a snapshot of the current tree (after writing `content`). */
  async function snap(
    engine: ReviewEngine,
    vault: string,
    content: string,
  ): Promise<SnapshotStatus> {
    await write(vault, 'note.md', content)
    return engine.snapshot()
  }

  it('blesses a pinned snapshot and leaves the working tree untouched', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    const s = await snap(engine, vault, 'v1\n')
    const applied = await engine.blessSnapshot(s.snapshot, s.seq)
    expect(applied).toBe(true)
    expect((await engine.status()).clean).toBe(true)
    // bless moves a pointer; the file on disk is unchanged
    expect(await readFile(join(vault, 'note.md'), 'utf8')).toBe('v1\n')
  })

  it('double-bless C3 then C5 ends trusting v5', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    await snap(engine, vault, 'v1\n')
    await snap(engine, vault, 'v2\n')
    const c3 = await snap(engine, vault, 'v3\n')
    await snap(engine, vault, 'v4\n')
    const c5 = await snap(engine, vault, 'v5\n') // disk is now v5
    expect(await engine.blessSnapshot(c3.snapshot, c3.seq)).toBe(true)
    expect(await engine.blessSnapshot(c5.snapshot, c5.seq)).toBe(true)
    // trusted == v5 → nothing pending (disk is v5)
    expect((await engine.status()).clean).toBe(true)
  })

  it('reversed C5 then stale C3 does not regress the baseline', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    const c3 = await snap(engine, vault, 'v3\n')
    const c5 = await snap(engine, vault, 'v5\n')
    expect(await engine.blessSnapshot(c5.snapshot, c5.seq)).toBe(true)
    // stale lower-seq signal arrives afterwards → must be a no-op
    expect(await engine.blessSnapshot(c3.snapshot, c3.seq)).toBe(false)
    expect((await engine.status()).clean).toBe(true) // still trusting v5
  })

  it('a partial bless leaves the rest pending', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    const c3 = await snap(engine, vault, 'v3\n')
    await snap(engine, vault, 'v5\n') // disk moved on to v5 after the snapshot
    expect(await engine.blessSnapshot(c3.snapshot, c3.seq)).toBe(true)
    const after = await engine.status()
    expect(after.clean).toBe(false) // v3 → v5 stays pending
    expect(after.changes[0]).toMatchObject({ path: 'note.md', kind: 'modify' })
  })

  it('duplicate signal for the same seq is idempotent', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'v0\n' })
    const s = await snap(engine, vault, 'v1\n')
    expect(await engine.blessSnapshot(s.snapshot, s.seq)).toBe(true)
    expect(await engine.blessSnapshot(s.snapshot, s.seq)).toBe(false)
  })

  it('the high-water mark survives across engine instances', async () => {
    const { engine, vault, gitdir } = await freshEngine({ 'note.md': 'v0\n' })
    const s = await snap(engine, vault, 'v1\n')
    expect(await engine.blessSnapshot(s.snapshot, s.seq)).toBe(true)
    const reopened = new ReviewEngine({ vaultPath: vault, gitDir: gitdir })
    await reopened.onboard()
    expect(await reopened.blessSnapshot(s.snapshot, s.seq)).toBe(false)
  })
})

describe('snapshot + renderChangesFile', () => {
  it('renders the active frontmatter shape with a cumulative diff', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'a\n' })
    await write(vault, 'note.md', 'a\nb\n')
    await write(vault, 'new.md', 'x\n')
    const status = await engine.snapshot()
    const md = renderChangesFile(status, 'demo')
    expect(md).toContain('accepted: false')
    expect(md).toContain(`snapshot: ${status.snapshot}`)
    expect(md).toContain(`seq: ${status.seq}`)
    expect(md).toContain('# Changes')
    expect(md).toContain('changes from baseline:')
    expect(md).toContain('[[new]]')
    expect(md).toContain('[[note]]')
  })

  it('omits the accepted checkbox when clean', async () => {
    const { engine } = await freshEngine({ 'note.md': 'a\n' })
    const status = await engine.snapshot()
    const md = renderChangesFile(status, 'demo')
    expect(status.clean).toBe(true)
    expect(md).not.toContain('accepted:')
    expect(md).toContain('Nothing pending')
  })

  it('a create-then-delete between checkpoints shows as no change', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'a\n' })
    await write(vault, 'tmp.md', 'temp\n')
    await engine.checkpoint() // snapshot with tmp.md present
    await rm(join(vault, 'tmp.md')) // remove it again
    const status = await engine.snapshot()
    // net diff baseline → now: tmp.md never existed at baseline and is gone now
    expect(status.changes.map((c) => c.path)).not.toContain('tmp.md')
    expect(status.clean).toBe(true)
  })
})

describe('changesFileName', () => {
  it('embeds the replica hash and a short snapshot oid', async () => {
    const name = changesFileName('fixed-replica', 'abcdef0123456789')
    expect(name).toMatch(/^changes-[0-9a-f]{12}-abcdef01\.md$/)
  })
})
