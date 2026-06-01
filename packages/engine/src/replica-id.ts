import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Subdirectory (inside the gitDir) the engine owns for its own state. */
const STATE_DIR = 'obsidian-guardian'
/** Filename of the persisted per-replica identifier. */
const REPLICA_FILE = 'replica-id'

/** Read a trimmed, non-empty id from a file, or null if absent/empty. */
async function readId(file: string): Promise<string | null> {
  try {
    const value = (await readFile(file, 'utf8')).trim()
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
export async function readOrCreateReplicaId(gitDir: string): Promise<string> {
  const dir = join(gitDir, STATE_DIR)
  const file = join(dir, REPLICA_FILE)

  const existing = await readId(file)
  if (existing) return existing

  await mkdir(dir, { recursive: true })
  const id = randomUUID()
  try {
    await writeFile(file, `${id}\n`, { flag: 'wx' })
    return id
  } catch {
    // Lost the create race — converge on whoever won.
    return (await readId(file)) ?? id
  }
}

/** The review-note filename for a replica id: `changes-<12-hex-hash>.md`. */
export function reviewNoteName(replicaId: string): string {
  return `changes-${replicaHash(replicaId)}.md`
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
  return `changes-${replicaHash(replicaId)}-${snapshotOid.slice(0, 8)}.md`
}

function replicaHash(replicaId: string): string {
  return createHash('sha256').update(replicaId).digest('hex').slice(0, 12)
}
