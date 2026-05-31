import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEngine, formatStatus } from '../src/commands'
import { resolveConfig } from '../src/config'
import { runWatch } from '../src/watch'

const tmpRoots: string[] = []

afterEach(async () => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

async function freshVault(): Promise<{ vault: string; gitDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'guardian-cli-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  await mkdir(vault, { recursive: true })
  await writeFile(join(vault, 'note.md'), 'hello\n')
  return { vault, gitDir: join(root, 'gitdb') }
}

describe('formatStatus', () => {
  it('summarises a clean tree and a changed tree', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)
    expect(formatStatus(await engine.status())).toMatch(/clean/)

    await writeFile(join(vault, 'added.md'), 'x\ny\n')
    const text = formatStatus(await engine.status())
    expect(text).toMatch(/1 change since baseline/)
    expect(text).toContain('added.md')
  })
})

describe('runWatch', () => {
  it('writes the review note on the initial pass and after a change', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)

    const onRefresh = vi.fn()
    const handle = await runWatch(engine, config, {
      poll: true,
      debounceMs: 20,
      onRefresh,
    })

    const notePath = join(vault, config.reviewFolder, engine.reviewNoteName)
    expect(await readFile(notePath, 'utf8')).toContain('status: blessed')
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await writeFile(join(vault, 'new.md'), 'fresh\n')
    await vi.waitFor(
      async () => {
        expect(await readFile(notePath, 'utf8')).toContain('[[new]]')
      },
      { timeout: 4000, interval: 50 },
    )

    await handle.close()
  })

  it('never reacts to its own review-note writes', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)

    const onRefresh = vi.fn()
    const handle = await runWatch(engine, config, {
      poll: true,
      debounceMs: 20,
      onRefresh,
    })
    // After the initial pass, a quiet period must not trigger more refreshes
    // (writing the review note would otherwise loop forever).
    await new Promise((r) => setTimeout(r, 400))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await handle.close()
  })
})
