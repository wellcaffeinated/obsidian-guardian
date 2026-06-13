import { diffLines } from 'diff'

/** One line of a rendered diff: a context, added, or removed line of text. */
export interface DiffLine {
  /** `' '` context, `'+'` added, `'-'` removed. */
  sign: ' ' | '+' | '-'
  /** The line text (no trailing newline). */
  text: string
}

/**
 * Cap (combined chars of both sides) above which we skip the precise Myers diff
 * (`diff`'s `diffLines`, O(N·D)) — which can block for *seconds* on a large or
 * heavily-rewritten file. `lineStats` runs on **every** changed file on every
 * status/timeline recompute (i.e. every debounced keystroke), so an uncapped
 * Myers diff there freezes the app. Above the cap we fall back to a cheap O(N)
 * line-multiset count for stats, and skip the inline diff entirely.
 */
const MAX_DIFF_CHARS = 200_000

/** True when the pair is too large to diff precisely without risking a freeze. */
function tooLargeToDiff(before: string, after: string): boolean {
  return before.length + after.length > MAX_DIFF_CHARS
}

/**
 * Cheap, O(N) approximate add/remove counts: lines present in `after` but not
 * matched by an equal line in `before` are "added", and vice versa for
 * "removed" (order-insensitive multiset difference). Not a true LCS, but a
 * sensible bounded fallback for files too large for Myers — a small edit in a
 * huge file still reports ~+1/−1, a rewrite reports the gross counts.
 */
function cheapLineStats(
  before: string,
  after: string,
): { added: number; removed: number } {
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  let added = 0
  for (const line of after.split('\n')) {
    const c = counts.get(line) ?? 0
    if (c > 0) counts.set(line, c - 1)
    else added++
  }
  let removed = 0
  for (const c of counts.values()) removed += c
  return { added, removed }
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
  // Large/heavily-edited files: skip Myers (would freeze) for a cheap O(N) count.
  if (tooLargeToDiff(before, after)) return cheapLineStats(before, after)
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
  // Too large for a precise diff: don't freeze rendering the inline view.
  if (tooLargeToDiff(before, after)) {
    return [{ sign: ' ', text: '⋯ file too large to show an inline diff' }]
  }
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
