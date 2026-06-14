// Startup-timeline profiler (NOT a correctness test; skipped unless OG_PROFILE=1).
//
// Purpose: quantify why a large vault makes the mobile review panel slow to show
// state. `timeline()` calls `buildChanges()` for the live diff PLUS once per
// checkpoint; with the work-index unprimed (the cold startup path) each falls
// back to `walkChanges`, which reads+hashes EVERY non-ignored file. So cold
// startup ≈ (1 + N_checkpoints) full vault walks = O((1+N)·M) file reads. Priming
// the index once (`rescan()`) collapses that to ~one scan + in-memory diffs.
//
// This run measures, per backend (node:fs and LightningFS/IndexedDB), on a
// SYNTHETIC vault only:
//   - onboard
//   - timeline COLD   (fresh engine, index unprimed) — today's startup cost
//   - rescan          (prime the index with one full scan)
//   - timeline WARM   (index primed) — the cost after the proposed fix
//
// Run it (resource-bounded) via `scripts/profile-timeline.sh`, or directly:
//   OG_PROFILE=1 pnpm --filter @obsidian-guardian/engine exec \
//     vitest run test/timeline-perf.profile.test.ts
//
// Resource safety: file/checkpoint counts are CLAMPED to hard maxima below so an
// env override can't blow up the sandbox; each case has a generous test timeout.
import 'fake-indexeddb/auto'
import * as nodeFs from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const PROFILE = process.env.OG_PROFILE === '1'

// --- bounded knobs ---------------------------------------------------------
const MAX_FILES = 3000
const MAX_CHECKPOINTS = 60
const clamp = (n: number, max: number): number =>
  Math.max(1, Math.min(max, Number.isFinite(n) ? n : 0))
const FILES = clamp(Number(process.env.OG_PROFILE_FILES ?? 300), MAX_FILES)
const CHECKPOINTS = clamp(
  Number(process.env.OG_PROFILE_CHECKPOINTS ?? 10),
  MAX_CHECKPOINTS,
)
// Files touched between checkpoints (keeps each checkpoint a distinct snapshot).
const CHURN = 5
const CASE_TIMEOUT_MS = 180_000

type Backend = 'node:fs' | 'idb'

const tmpRoots: string[] = []
let dbCounter = 0
afterEach(async () => {
  while (tmpRoots.length) {
    const root = tmpRoots.pop()
    if (root) await rm(root, { recursive: true, force: true })
  }
})

const pad = (n: number): string => String(n).padStart(5, '0')
const noteContent = (i: number, rev = 0): string =>
  `# note ${i}\n\nrev ${rev}\n${'lorem ipsum dolor sit amet '.repeat(4)}\n`

async function timeAsync<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now()
  const out = await fn()
  return [out, performance.now() - t0]
}

/** Build a routing fs + engine for the chosen backend over a real temp worktree. */
async function makeEngine(backend: Backend): Promise<{
  engine: ReviewEngine
  vault: string
  remake: () => ReviewEngine
}> {
  const root = await mkdtemp(join(tmpdir(), 'og-perf-'))
  tmpRoots.push(root)
  const vault = join(root, 'vault')
  await mkdir(vault, { recursive: true })

  const dbName = `og-perf-idb-${dbCounter++}`
  const gitDir = backend === 'idb' ? '/git' : join(root, 'gitdir')
  const build = (): ReviewEngine => {
    const gitDirFs =
      backend === 'idb'
        ? (new LightningFS(dbName) as unknown as PromiseFsClient)
        : (nodeFs as unknown as PromiseFsClient)
    const fs = createRoutingFs({
      gitDir,
      gitDirFs,
      workTreeFs: nodeFs as unknown as PromiseFsClient,
    })
    const config: EngineConfig = { fs, vaultPath: vault, gitDir }
    return new ReviewEngine(config)
  }
  // `remake` returns a brand-new engine over the SAME stores — simulates an app
  // restart (fresh in-memory engine, persisted gitdir), so timeline() is cold.
  return { engine: build(), vault, remake: build }
}

async function seedVault(vault: string, files: number): Promise<void> {
  await mkdir(join(vault, 'notes'), { recursive: true })
  for (let i = 0; i < files; i++) {
    await writeFile(join(vault, 'notes', `n${pad(i)}.md`), noteContent(i))
  }
}

async function churnAndCheckpoint(
  engine: ReviewEngine,
  vault: string,
  round: number,
  files: number,
): Promise<void> {
  for (let k = 0; k < CHURN; k++) {
    const idx = (round * CHURN + k) % files
    await writeFile(
      join(vault, 'notes', `n${pad(idx)}.md`),
      noteContent(idx, round + 1),
    )
  }
  await engine.checkpoint()
}

describe.skipIf(!PROFILE)('timeline startup profile (synthetic vault)', () => {
  for (const backend of ['node:fs', 'idb'] as Backend[]) {
    it(
      `${backend}: ${FILES} files × ${CHECKPOINTS} checkpoints`,
      async () => {
        const { engine, vault, remake } = await makeEngine(backend)

        await seedVault(vault, FILES)
        const [, tOnboard] = await timeAsync(() => engine.onboard())
        for (let r = 0; r < CHECKPOINTS; r++) {
          await churnAndCheckpoint(engine, vault, r, FILES)
        }

        // Simulate a restart: a fresh engine over the persisted store.
        const cold = remake()
        const [coldTl, tCold] = await timeAsync(() => cold.timeline())
        const [, tRescan] = await timeAsync(() => cold.rescan())
        const [warmTl, tWarm] = await timeAsync(() => cold.timeline())

        // Correctness guard: priming the index must not change the result.
        expect(warmTl.checkpoints.length).toBe(coldTl.checkpoints.length)
        expect(warmTl.current.length).toBe(coldTl.current.length)

        const fmt = (n: number): string => `${n.toFixed(1)}ms`
        // process.stdout.write bypasses vitest's console capture so the table
        // always reaches the terminal.
        process.stdout.write(
          `\n[profile ${backend}] files=${FILES} checkpoints=${CHECKPOINTS}\n` +
            `  onboard             ${fmt(tOnboard)}\n` +
            `  timeline COLD       ${fmt(tCold)}   (unprimed: (1+N) full walks)\n` +
            `  rescan (prime)      ${fmt(tRescan)}\n` +
            `  timeline WARM       ${fmt(tWarm)}   (primed: in-memory diffs)\n` +
            `  prime+warm total    ${fmt(tRescan + tWarm)}\n` +
            `  speedup cold/(prime+warm) ${(tCold / Math.max(tRescan + tWarm, 0.01)).toFixed(1)}×\n`,
        )

        // The whole point: a primed timeline is cheaper than the cold one. Use a
        // loose bound (prime+warm < cold) so the assertion is meaningful without
        // being timing-flaky on a tiny vault.
        expect(tRescan + tWarm).toBeLessThanOrEqual(tCold)
      },
      CASE_TIMEOUT_MS,
    )
  }
})
