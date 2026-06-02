import { join } from 'node:path'
import type { PromiseFsClient } from 'isomorphic-git'
import type { ClientId, LocalState } from './types'

/** Subdirectory (inside the gitDir) the engine owns for its own state. */
const STATE_DIR = 'obsidian-guardian'
/** Coordination state file (observedSeq + own blessSeq + pending blesses). */
const COORD_FILE = 'coordination.json'

/**
 * Per-device coordination state, persisted as JSON **inside the gitDir** — which
 * is device-local and outside the synced vault tree, so it never syncs and never
 * contends across devices. Holds the per-peer high-water marks (`observedSeq`),
 * this device's own `blessSeq`, and `pending` bless records whose bytes have not
 * yet synced in. Crash-safe via atomic rename.
 */
function coordPath(gitDir: string): string {
  return join(gitDir, STATE_DIR, COORD_FILE)
}

function emptyState(self: ClientId): LocalState {
  return { self, observedSeq: {}, blessSeq: 0, pending: [] }
}

/** Read the coordination state, or a fresh empty state if none persisted yet. */
export async function readLocalState(
  fs: PromiseFsClient,
  gitDir: string,
  self: ClientId,
): Promise<LocalState> {
  try {
    const raw = (await fs.promises.readFile(coordPath(gitDir), 'utf8')) as string
    const parsed = JSON.parse(raw) as Partial<LocalState>
    return {
      self,
      observedSeq: parsed.observedSeq ?? {},
      blessSeq: parsed.blessSeq ?? 0,
      pending: parsed.pending ?? [],
    }
  } catch {
    return emptyState(self)
  }
}

/**
 * Persist the coordination state. A plain write (the `PromiseFsClient` interface
 * isomorphic-git/mobile adapters expose has no `rename`, so no temp-swap); a torn
 * write is tolerated because crash recovery re-ingests every bless file
 * idempotently and re-derives `observedSeq`/`pending`.
 */
export async function writeLocalState(
  fs: PromiseFsClient,
  gitDir: string,
  state: LocalState,
): Promise<void> {
  const dir = join(gitDir, STATE_DIR)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.writeFile(
    coordPath(gitDir),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}
