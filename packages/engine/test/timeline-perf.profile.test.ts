// Startup-timeline profiler (NOT a correctness test; skipped unless OG_PROFILE=1).
//
// Purpose: track the cost of building the review panel's timeline on a large
// vault. Historically `timeline()` did (1 + N_checkpoints) full vault walks and
// read every changed blob for every (collapsed) checkpoint — O((1+N)·M). It now
// (a) primes the work index once and (b) ships only a CHEAP per-checkpoint
// summary, fetching full per-file stats lazily via `checkpointDiff()` on expand.
//
// This run measures, per backend (node:fs and LightningFS/IndexedDB), on a
// SYNTHETIC vault only:
//   - onboard
//   - timeline STARTUP   (fresh engine = simulated restart) — the headline cost
//   - timeline REPEAT    (same engine, index warm) — an in-session refresh
//   - checkpointDiff      (lazy full diff for ONE expanded checkpoint)
//
// Compare STARTUP across commits for before/after. (Pre-optimization numbers are
// recorded in plans/mobile-refresh-fixes.md.)
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

        // Simulate a restart: a fresh engine over the persisted store, so the
        // first timeline() is the real startup cost (index cold, must prime).
        const startup = remake()
        const [startTl, tStartup] = await timeAsync(() => startup.timeline())
        const [repeatTl, tRepeat] = await timeAsync(() => startup.timeline())
        // Lazy expand of the OLDEST checkpoint (largest diff to the working tree).
        const oldest = startTl.checkpoints.at(-1)
        const [, tExpand] = oldest
          ? await timeAsync(() => startup.checkpointDiff(oldest.oid))
          : [null, 0]

        // Correctness guard: a repeat timeline is stable.
        expect(repeatTl.checkpoints.length).toBe(startTl.checkpoints.length)
        expect(repeatTl.current.length).toBe(startTl.current.length)

        const fmt = (n: number): string => `${n.toFixed(1)}ms`
        // process.stdout.write bypasses vitest's console capture so the table
        // always reaches the terminal.
        process.stdout.write(
          `\n[profile ${backend}] files=${FILES} checkpoints=${CHECKPOINTS}\n` +
            `  onboard             ${fmt(tOnboard)}\n` +
            `  timeline STARTUP    ${fmt(tStartup)}   (fresh engine: prime + cheap summaries)\n` +
            `  timeline REPEAT     ${fmt(tRepeat)}   (index warm)\n` +
            `  checkpointDiff      ${fmt(tExpand)}   (lazy full diff, one checkpoint)\n`,
        )

        // The warm repeat must not be dramatically worse than the cold startup
        // (loose bound to avoid timing flakiness on tiny vaults).
        expect(tRepeat).toBeLessThanOrEqual(tStartup * 2 + 50)
      },
      CASE_TIMEOUT_MS,
    )
  }
})
