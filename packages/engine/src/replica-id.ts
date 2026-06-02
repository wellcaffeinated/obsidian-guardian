import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PromiseFsClient } from 'isomorphic-git'
import { ensureDir } from './fs-utils'

/** Subdirectory (inside the gitDir) the engine owns for its own state. */
const STATE_DIR = 'obsidian-guardian'
/** Filename of the persisted per-replica identifier. */
const REPLICA_FILE = 'replica-id'

/** Read a trimmed, non-empty id from a file, or null if absent/empty. */
async function readId(
  fs: PromiseFsClient,
  file: string,
): Promise<string | null> {
  try {
    const value = ((await fs.promises.readFile(file, 'utf8')) as string).trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/**
 * A stable identifier for this *replica* — one independent baseline / working
 * copy of a vault. Persisted inside the gitDir (which is per-machine and outside
 * the synced vault tree), so every gitDir gets its own id. This keeps each
 * replica's review note (`changes-<hash>.md`) separate in a synced vault, with
 * no collisions across devices and no hardware probing.
 *
 * The id lives in a subdir the engine owns (`<gitDir>/obsidian-guardian/`);
 * git itself only reads named paths in the gitDir, so this file is inert to it.
 * Creation is an exclusive (`wx`) write, so two processes onboarding a fresh
 * shared gitDir at once converge on the first writer's id.
 */
export async function readOrCreateReplicaId(
  fs: PromiseFsClient,
  gitDir: string,
): Promise<string> {
  const dir = join(gitDir, STATE_DIR)
  const file = join(dir, REPLICA_FILE)

  const existing = await readId(fs, file)
  if (existing) return existing

  await ensureDir(fs, dir)
  const id = randomUUID()
  try {
    // Exclusive create so concurrent fresh onboards converge on the first
    // writer's id (node:fs honours `wx`; minimal mobile backends ignore the
    // flag, but a single-process device has no race to lose).
    await fs.promises.writeFile(file, `${id}\n`, { flag: 'wx' })
    return id
  } catch {
    // Lost the create race — converge on whoever won.
    return (await readId(fs, file)) ?? id
  }
}

/** The review-note filename for a replica id: `changes-<12-hex-hash>.md`. */
export function reviewNoteName(replicaId: string): string {
  return `changes-${replicaHash(replicaId)}.md`
}

/**
 * Filename prefix shared by all of one replica's rotating signal files:
 * `changes-<12-hex-replica>-`. A watcher matches this prefix to act only on its
 * **own** replica's files — never another device's files synced into the same
 * review folder.
 */
export function changesFilePrefix(replicaId: string): string {
  return `changes-${replicaHash(replicaId)}-`
}

/**
 * The rotating signal filename for a replica + snapshot:
 * `changes-<12-hex-replica>-<8-hex-snapshot>.md`. The replica hash keeps two
 * devices reviewing one synced vault from ever sharing a filename; the short
 * snapshot oid makes each snapshot's file immutable and distinct.
 */
export function changesFileName(
  replicaId: string,
  snapshotOid: string,
): string {
  return `${changesFilePrefix(replicaId)}${snapshotOid.slice(0, 8)}.md`
}

function replicaHash(replicaId: string): string {
  return createHash('sha256').update(replicaId).digest('hex').slice(0, 12)
}
