import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
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

/** Find the current signal file containing `needle`, or null. */
async function findSignal(
  reviewDir: string,
  prefix: string,
  needle: string,
): Promise<{ name: string; content: string } | null> {
  let names: string[]
  try {
    names = (await readdir(reviewDir)).filter(
      (n) => n.startsWith(prefix) && n.endsWith('.md'),
    )
  } catch {
    return null
  }
  for (const name of names) {
    const content = await readFile(join(reviewDir, name), 'utf8')
    if (content.includes(needle)) return { name, content }
  }
  return null
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
  it('writes a clean snapshot file initially and an accepted:false file after a change', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)
    const reviewDir = join(vault, config.reviewFolder)

    const onRefresh = vi.fn()
    const handle = await runWatch(engine, config, {
      poll: true,
      debounceMs: 20,
      onRefresh,
    })

    // initial pass: a clean snapshot file exists, no accepted checkbox
    const clean = await findSignal(reviewDir, engine.signalPrefix, '# Changes')
    expect(clean?.content).toContain('Nothing pending')
    expect(clean?.content).not.toContain('accepted:')
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await writeFile(join(vault, 'new.md'), 'fresh\n')
    await vi.waitFor(
      async () => {
        const sig = await findSignal(reviewDir, engine.signalPrefix, '[[new]]')
        expect(sig?.content).toContain('accepted: false')
        expect(sig?.content).toMatch(/^snapshot: [0-9a-f]{40}$/m)
        expect(sig?.content).toMatch(/^seq: \d+$/m)
      },
      { timeout: 4000, interval: 50 },
    )

    await handle.close()
  })

  it('never reacts to its own writes', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)

    const onRefresh = vi.fn()
    const handle = await runWatch(engine, config, {
      poll: true,
      debounceMs: 20,
      onRefresh,
    })
    // Writing the snapshot file must not retrigger the watcher.
    await new Promise((r) => setTimeout(r, 400))
    expect(onRefresh).toHaveBeenCalledTimes(1)

    await handle.close()
  })

  it('blesses the pinned snapshot when accepted: true is synced back', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)
    const reviewDir = join(vault, config.reviewFolder)

    const onBless = vi.fn()
    const handle = await runWatch(engine, config, {
      poll: true,
      debounceMs: 20,
      onBless,
    })

    await writeFile(join(vault, 'new.md'), 'fresh\n')
    let signalName = ''
    await vi.waitFor(
      async () => {
        const sig = await findSignal(reviewDir, engine.signalPrefix, '[[new]]')
        expect(sig).not.toBeNull()
        signalName = (sig as { name: string }).name
      },
      { timeout: 4000, interval: 50 },
    )

    // Simulate the mobile edit syncing back: toggle the checkbox on.
    const path = join(reviewDir, signalName)
    const toggled = (await readFile(path, 'utf8')).replace(
      'accepted: false',
      'accepted: true',
    )
    await writeFile(path, toggled)

    await vi.waitFor(
      async () => {
        expect((await engine.status()).clean).toBe(true) // baseline advanced
      },
      { timeout: 4000, interval: 50 },
    )
    expect(onBless).toHaveBeenCalledWith(expect.any(String), true)

    await handle.close()
  })

  it('treats a replayed (already-blessed) accepted signal as a no-op', async () => {
    const { vault, gitDir } = await freshVault()
    const config = resolveConfig({ vault, gitDir })
    const engine = await createEngine(config)
    const reviewDir = join(vault, config.reviewFolder)

    const onBless = vi.fn()
    const handle = await runWatch(engine, config, {
      poll: true,
      debounceMs: 20,
      graceMs: 10_000, // keep the consumed file around so we can replay it
      onBless,
    })

    await writeFile(join(vault, 'new.md'), 'fresh\n')
    let signalName = ''
    await vi.waitFor(
      async () => {
        const sig = await findSignal(reviewDir, engine.signalPrefix, '[[new]]')
        expect(sig).not.toBeNull()
        signalName = (sig as { name: string }).name
      },
      { timeout: 4000, interval: 50 },
    )

    // Accept it once → applied.
    const path = join(reviewDir, signalName)
    const accepted = (await readFile(path, 'utf8')).replace(
      'accepted: false',
      'accepted: true',
    )
    await writeFile(path, accepted)
    await vi.waitFor(
      () => expect(onBless).toHaveBeenCalledWith(expect.any(String), true),
      {
        timeout: 4000,
        interval: 50,
      },
    )

    // Replay the same accepted signal (a duplicate sync) → must be a no-op, and
    // must not regress the now-clean baseline.
    await writeFile(path, `${accepted}\n<!-- replay -->\n`)
    await vi.waitFor(
      () => expect(onBless).toHaveBeenLastCalledWith(expect.any(String), false),
      { timeout: 4000, interval: 50 },
    )
    expect((await engine.status()).clean).toBe(true)

    await handle.close()
  })
})
