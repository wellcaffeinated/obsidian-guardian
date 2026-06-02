import { diffLines } from 'diff'

/** One line of a rendered diff: a context, added, or removed line of text. */
export interface DiffLine {
  /** `' '` context, `'+'` added, `'-'` removed. */
  sign: ' ' | '+' | '-'
  /** The line text (no trailing newline). */
  text: string
}

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

/**
 * Render a line-based diff between two text blobs as a flat list of signed lines
 * (context + added + removed), in file order. The inverse detail of
 * {@link lineStats}; used to show an expandable inline diff per file.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const out: DiffLine[] = []
  for (const part of diffLines(before, after)) {
    const sign: DiffLine['sign'] = part.added ? '+' : part.removed ? '-' : ' '
    const lines = part.value.split('\n')
    // diffLines parts end with a trailing newline ⇒ a trailing empty segment;
    // drop it so we don't emit a phantom blank line per hunk.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    for (const text of lines) out.push({ sign, text })
  }
  return out
}
