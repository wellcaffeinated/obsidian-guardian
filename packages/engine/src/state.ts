import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Subdirectory (inside the gitDir) the engine owns for its own state. */
const STATE_DIR = 'obsidian-guardian'
/** Monotonic snapshot sequence counter. */
const SEQ_FILE = 'snapshot-seq'
/** Highest snapshot seq ever blessed (the bless high-water mark). */
const HWM_FILE = 'bless-hwm'

/**
 * Engine state counters persisted **inside the gitDir** — which is per-machine
 * and outside the synced vault tree, so these never sync and never contend
 * across devices. This is the key to the bless protocol's order-independence:
 * the high-water mark is local-only, so a stale signal synced from another
 * device can never drag it backwards.
 */
async function readCounter(file: string): Promise<number> {
  try {
    const value = Number.parseInt((await readFile(file, 'utf8')).trim(), 10)
    return Number.isFinite(value) ? value : 0
  } catch {
    return 0
  }
}

async function writeCounter(
  gitDir: string,
  name: string,
  value: number,
): Promise<void> {
  const dir = join(gitDir, STATE_DIR)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), `${value}\n`)
}

/** Current snapshot seq without advancing it (0 if none assigned yet). */
export async function readSeq(gitDir: string): Promise<number> {
  return readCounter(join(gitDir, STATE_DIR, SEQ_FILE))
}

/** Atomically advance and return the next monotonic snapshot seq. */
export async function nextSeq(gitDir: string): Promise<number> {
  const next = (await readSeq(gitDir)) + 1
  await writeCounter(gitDir, SEQ_FILE, next)
  return next
}

/** The highest snapshot seq ever blessed for this gitDir (0 if none). */
export async function readBlessHighWater(gitDir: string): Promise<number> {
  return readCounter(join(gitDir, STATE_DIR, HWM_FILE))
}

/** Record a new bless high-water mark. */
export async function writeBlessHighWater(
  gitDir: string,
  seq: number,
): Promise<void> {
  await writeCounter(gitDir, HWM_FILE, seq)
}
