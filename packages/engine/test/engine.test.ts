import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ReviewEngine } from '@obsidian-bedrock/engine'
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
): Promise<{ engine: ReviewEngine; vault: string; gitdir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'bedrock-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  const gitdir = join(root, 'gitdb')
  await mkdir(vault, { recursive: true })
  for (const [rel, content] of Object.entries(baseline)) {
    await write(vault, rel, content)
  }
  const engine = new ReviewEngine({ vaultPath: vault, gitDir: gitdir })
  await engine.onboard()
  return { engine, vault, gitdir }
}

describe('onboard', () => {
  it('starts clean and is idempotent', async () => {
    const { engine } = await freshEngine({ 'note.md': 'hello\n' })
    expect((await engine.status()).clean).toBe(true)
    const before = (await engine.status()).marker
    await engine.onboard() // second call must not advance the marker
    expect((await engine.status()).marker).toBe(before)
  })
})

describe('status', () => {
  it('detects an added file with line counts', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'hello\n' })
    await write(vault, 'new.md', 'a\nb\nc\n')
    const status = await engine.status()
    expect(status.clean).toBe(false)
    const entry = status.changes.find((c) => c.path === 'new.md')
    expect(entry).toMatchObject({ kind: 'add', added: 3, removed: 0 })
  })

  it('detects a modified file with +/- counts', async () => {
    const { engine, vault } = await freshEngine({
      'note.md': 'one\ntwo\nthree\n',
    })
    await write(vault, 'note.md', 'one\ntwo\nTHREE\n')
    const entry = (await engine.status()).changes[0]
    expect(entry).toMatchObject({ kind: 'modify', added: 1, removed: 1 })
  })

  it('detects a deleted file', async () => {
    const { engine, vault } = await freshEngine({ 'gone.md': 'x\ny\n' })
    await rm(join(vault, 'gone.md'))
    const entry = (await engine.status()).changes[0]
    expect(entry).toMatchObject({ kind: 'delete', path: 'gone.md', removed: 2 })
  })

  it('detects a rename (same content)', async () => {
    const { engine, vault } = await freshEngine({ 'a.md': 'same\ncontent\n' })
    await rm(join(vault, 'a.md'))
    await write(vault, 'b.md', 'same\ncontent\n')
    const changes = (await engine.status()).changes
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      kind: 'rename',
      path: 'b.md',
      renamedFrom: 'a.md',
    })
  })

  it('ignores volatile Obsidian state', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'hi\n' })
    await write(vault, '.obsidian/workspace.json', '{"x":1}')
    await write(vault, '.obsidian/plugins/foo/main.js', 'console.log(1)')
    const paths = (await engine.status()).changes.map((c) => c.path)
    expect(paths).not.toContain('.obsidian/workspace.json')
    // plugin files are NOT ignored by default
    expect(paths).toContain('.obsidian/plugins/foo/main.js')
  })
})

describe('bless', () => {
  it('advances the marker and clears pending', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'hello\n' })
    const before = (await engine.status()).marker
    await write(vault, 'note.md', 'hello\nworld\n')
    await engine.bless()
    const after = await engine.status()
    expect(after.clean).toBe(true)
    expect(after.marker).not.toBe(before)
  })
})

describe('revert', () => {
  it('restores a modified file', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'original\n' })
    await write(vault, 'note.md', 'tampered\n')
    await engine.revert('note.md')
    expect(await readFile(join(vault, 'note.md'), 'utf8')).toBe('original\n')
    expect((await engine.status()).clean).toBe(true)
  })

  it('deletes a newly added file', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'x\n' })
    await write(vault, 'added.md', 'junk\n')
    await engine.revert('added.md')
    expect(existsSync(join(vault, 'added.md'))).toBe(false)
    expect((await engine.status()).clean).toBe(true)
  })
})

describe('rollback', () => {
  it('resets the whole tree to baseline', async () => {
    const { engine, vault } = await freshEngine({
      'a.md': 'A\n',
      'b.md': 'B\n',
    })
    await write(vault, 'a.md', 'A changed\n')
    await rm(join(vault, 'b.md'))
    await write(vault, 'c.md', 'new\n')
    await engine.rollback()
    expect(await readFile(join(vault, 'a.md'), 'utf8')).toBe('A\n')
    expect(await readFile(join(vault, 'b.md'), 'utf8')).toBe('B\n')
    expect(existsSync(join(vault, 'c.md'))).toBe(false)
    expect((await engine.status()).clean).toBe(true)
  })
})

describe('tag', () => {
  it('writes a tag ref at the marker', async () => {
    const { engine, gitdir } = await freshEngine({ 'note.md': 'hi\n' })
    await engine.tag('before-bulk')
    expect(existsSync(join(gitdir, 'refs', 'tags', 'before-bulk'))).toBe(true)
  })
})

describe('refresh', () => {
  it('writes the review note and does not report the review folder', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'hi\n' })
    await write(vault, 'new.md', 'fresh\n')
    const status = await engine.refresh()
    const note = await readFile(
      join(vault, '_Review', 'Pending Review.md'),
      'utf8',
    )
    expect(note).toContain('Pending review')
    expect(note).toContain('[[new]]')
    // the review folder must never show up as its own pending change
    expect(status.changes.map((c) => c.path)).not.toContain(
      '_Review/Pending Review.md',
    )
  })

  it('renders a clean note when nothing is pending', async () => {
    const { engine, vault } = await freshEngine({ 'note.md': 'hi\n' })
    await engine.refresh()
    const note = await readFile(
      join(vault, '_Review', 'Pending Review.md'),
      'utf8',
    )
    expect(note).toContain('status: blessed')
    expect(note).toContain('Clean')
  })
})
