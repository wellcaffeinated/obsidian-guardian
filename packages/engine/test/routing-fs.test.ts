import * as nodeFs from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRoutingFs,
  type EngineConfig,
  ReviewEngine,
} from '@obsidian-guardian/engine'
import type { PromiseFsClient } from 'isomorphic-git'
import { afterEach, describe, expect, it } from 'vitest'

const tmpRoots: string[] = []

afterEach(async () => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

/**
 * Wrap a real `PromiseFsClient`, recording the first (path) argument of every
 * call so a test can assert which backend each path was dispatched to.
 */
function spyFs(backend: PromiseFsClient): {
  fs: PromiseFsClient
  paths: string[]
} {
  const paths: string[] = []
  const src = backend.promises as unknown as Record<
    string,
    ((...a: unknown[]) => unknown) | undefined
  >
  const promises = {} as Record<string, (...a: unknown[]) => unknown>
  for (const name of Object.keys(src)) {
    const fn = src[name]
    if (typeof fn !== 'function') continue
    promises[name] = (...args: unknown[]) => {
      if (typeof args[0] === 'string') paths.push(args[0])
      return fn.apply(backend.promises, args)
    }
  }
  return { fs: { promises } as unknown as PromiseFsClient, paths }
}

async function routedEngine(): Promise<{
  engine: ReviewEngine
  vault: string
  gitdir: string
  workPaths: string[]
  gitPaths: string[]
}> {
  const root = await mkdtemp(join(tmpdir(), 'guardian-routing-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  const gitdir = join(root, 'gitdb')
  await mkdir(vault, { recursive: true })

  const work = spyFs(nodeFs as unknown as PromiseFsClient)
  const git = spyFs(nodeFs as unknown as PromiseFsClient)
  const fs = createRoutingFs({
    gitDir: gitdir,
    gitDirFs: git.fs,
    workTreeFs: work.fs,
  })
  const config: EngineConfig = { fs, vaultPath: vault, gitDir: gitdir }
  const engine = new ReviewEngine(config)
  return { engine, vault, gitdir, workPaths: work.paths, gitPaths: git.paths }
}

describe('createRoutingFs', () => {
  it('routes gitdir paths to one backend and vault paths to the other', async () => {
    const { engine, vault, gitdir, workPaths, gitPaths } = await routedEngine()
    await engine.onboard()
    await nodeFs.promises.writeFile(join(vault, 'note.md'), 'hello\n')
    const status = await engine.status()

    // Parity: the engine works exactly as through a single fs.
    expect(status.clean).toBe(false)
    expect(status.changes.map((c) => c.path)).toContain('note.md')

    // Routing contract: every path each backend saw lands in its own realm.
    expect(gitPaths.length).toBeGreaterThan(0)
    expect(workPaths.length).toBeGreaterThan(0)
    for (const p of gitPaths) expect(p.startsWith(gitdir)).toBe(true)
    for (const p of workPaths) expect(p.startsWith(gitdir)).toBe(false)
  })

  it('survives a full onboard → bless lifecycle through the router', async () => {
    const { engine, vault } = await routedEngine()
    await engine.onboard()
    await nodeFs.promises.writeFile(join(vault, 'a.md'), 'one\n')
    expect((await engine.status()).clean).toBe(false)
    await engine.bless()
    expect((await engine.status()).clean).toBe(true)
  })
})
