import { join } from 'node:path'
import type { PromiseFsClient } from 'isomorphic-git'
import type { BlessRecord, ClientId, DeviceState } from './types'

/**
 * The synced signal folder is the **only** cross-device channel. It lives inside
 * the vault (so Obsidian Sync / Syncthing / iCloud replicate it as ordinary
 * content) under a non-dot subfolder of the review folder — `_OG/sync/`. The
 * device-local gitDir is git-ignored from `_OG/`, so these files sync but never
 * land in the never-synced object store.
 *
 * Each device writes exactly two files — `device-<id>.json` and
 * `bless-<id>.json` — and only its own (single-writer ⇒ no sync-conflict copies).
 * It reads every peer's files but never edits them.
 */
const DEVICE_PREFIX = 'device-'
const BLESS_PREFIX = 'bless-'
const SUFFIX = '.json'

/** Absolute path of the synced signal folder for a vault + review folder. */
export function syncDirPath(vaultPath: string, reviewFolder: string): string {
  return join(vaultPath, reviewFolder, 'sync')
}

async function writeJson(
  fs: PromiseFsClient,
  syncDir: string,
  name: string,
  value: unknown,
): Promise<void> {
  await fs.promises.mkdir(syncDir, { recursive: true })
  await fs.promises.writeFile(
    join(syncDir, name),
    `${JSON.stringify(value, null, 2)}\n`,
  )
}

/** Publish this device's presence/housekeeping state (overwritten in place). */
export async function writeDeviceState(
  fs: PromiseFsClient,
  syncDir: string,
  state: DeviceState,
): Promise<void> {
  await writeJson(
    fs,
    syncDir,
    `${DEVICE_PREFIX}${state.client}${SUFFIX}`,
    state,
  )
}

/** Publish this device's latest bless record (overwritten in place = LWW). */
export async function writeBlessRecord(
  fs: PromiseFsClient,
  syncDir: string,
  rec: BlessRecord,
): Promise<void> {
  await writeJson(fs, syncDir, `${BLESS_PREFIX}${rec.client}${SUFFIX}`, rec)
}

async function listJson(
  fs: PromiseFsClient,
  syncDir: string,
  prefix: string,
): Promise<string[]> {
  try {
    const names = (await fs.promises.readdir(syncDir)) as string[]
    return names.filter((n) => n.startsWith(prefix) && n.endsWith(SUFFIX))
  } catch {
    return [] // folder not created yet
  }
}

async function readJson<T>(
  fs: PromiseFsClient,
  syncDir: string,
  name: string,
): Promise<T | null> {
  try {
    const raw = (await fs.promises.readFile(
      join(syncDir, name),
      'utf8',
    )) as string
    return JSON.parse(raw) as T
  } catch {
    // Missing, or a half-synced/partial write — skip; a later sync settle retries.
    return null
  }
}

/** Read every peer's (and our own) bless record. Malformed/partial files skipped. */
export async function readBlessRecords(
  fs: PromiseFsClient,
  syncDir: string,
): Promise<BlessRecord[]> {
  const out: BlessRecord[] = []
  for (const name of await listJson(fs, syncDir, BLESS_PREFIX)) {
    const rec = await readJson<BlessRecord>(fs, syncDir, name)
    if (rec && Array.isArray(rec.manifest) && typeof rec.client === 'string') {
      out.push(rec)
    }
  }
  return out
}

/** Read every device's published state (for presence/divergence UI). */
export async function readDeviceStates(
  fs: PromiseFsClient,
  syncDir: string,
): Promise<DeviceState[]> {
  const out: DeviceState[] = []
  for (const name of await listJson(fs, syncDir, DEVICE_PREFIX)) {
    const state = await readJson<DeviceState>(fs, syncDir, name)
    if (state && typeof state.client === 'string') out.push(state)
  }
  return out
}

/** The two filenames this device owns (its single-writer signal files). */
export function ownSignalFiles(client: ClientId): {
  device: string
  bless: string
} {
  return {
    device: `${DEVICE_PREFIX}${client}${SUFFIX}`,
    bless: `${BLESS_PREFIX}${client}${SUFFIX}`,
  }
}
