import { diffLines } from 'diff'

/**
 * Heuristic binary check: a NUL byte in the first 8 KiB means "don't diff".
 */
export function isBinary(buf: Uint8Array): boolean {
  const len = Math.min(buf.length, 8000)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Decode bytes as UTF-8 text. */
export function decode(buf: Uint8Array): string {
  return new TextDecoder().decode(buf)
}

/**
 * Count added/removed lines between two text blobs (line-based diff).
 */
export function lineStats(
  before: string,
  after: string,
): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const part of diffLines(before, after)) {
    if (part.added) added += part.count ?? 0
    else if (part.removed) removed += part.count ?? 0
  }
  return { added, removed }
}
