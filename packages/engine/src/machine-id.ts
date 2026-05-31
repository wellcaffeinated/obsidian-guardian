import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

/** Files that may carry a stable per-machine identifier (Linux/systemd). */
const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id']

/** First non-empty, trimmed file content from a list; null if none readable. */
function firstNonEmpty(paths: readonly string[]): string | null {
  for (const path of paths) {
    try {
      const value = readFileSync(path, 'utf8').trim()
      if (value) return value
    } catch {
      // unreadable / absent — try the next candidate
    }
  }
  return null
}

/**
 * A stable identifier for the machine the engine runs on. Prefers the OS
 * machine-id (distinct across computers, survives renames), falling back to the
 * hostname. Used to keep each machine's review note separate in a synced vault,
 * so two devices reviewing the same vault never collide on the same file.
 */
export function defaultMachineId(): string {
  return firstNonEmpty(MACHINE_ID_FILES) ?? hostname()
}

/** The review-note filename for a machine id: `changes-<12-hex-hash>.md`. */
export function reviewNoteName(machineId: string): string {
  const hash = createHash('sha256').update(machineId).digest('hex').slice(0, 12)
  return `changes-${hash}.md`
}
