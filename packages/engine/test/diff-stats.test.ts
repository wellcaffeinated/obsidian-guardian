import { lineDiff, lineStats } from '@obsidian-guardian/engine'
import { describe, expect, it } from 'vitest'

describe('lineStats', () => {
  it('counts added/removed lines precisely for normal-size text', () => {
    expect(lineStats('a\nb\nc\n', 'a\nB\nc\n')).toEqual({
      added: 1,
      removed: 1,
    })
    expect(lineStats('a\nb\n', 'a\nb\nc\n')).toEqual({ added: 1, removed: 0 })
    expect(lineStats('a\nb\nc\n', 'a\n')).toEqual({ added: 0, removed: 2 })
  })

  it('falls back to a cheap O(N) count above the size cap (no Myers freeze)', () => {
    // A huge file with a single changed line: precise Myers would be ~+1/-1 but
    // could take seconds; the cheap multiset fallback also reports ~+1/-1, fast.
    const n = 200_000
    const before = `${Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')}\n`
    const after = before.replace('line 0\n', 'CHANGED\n')

    const start = performance.now()
    const stats = lineStats(before, after)
    const ms = performance.now() - start

    expect(stats).toEqual({ added: 1, removed: 1 })
    expect(ms).toBeLessThan(1000) // would be many seconds under uncapped Myers
  })

  it('cheap fallback reports gross counts for a large rewrite', () => {
    const before = `${Array.from({ length: 60_000 }, (_, i) => `a${i}`).join('\n')}\n`
    const after = `${Array.from({ length: 60_000 }, (_, i) => `b${i}`).join('\n')}\n`
    const { added, removed } = lineStats(before, after)
    expect(added).toBeGreaterThan(50_000)
    expect(removed).toBeGreaterThan(50_000)
  })
})

describe('lineDiff', () => {
  it('renders signed lines for normal-size text', () => {
    expect(lineDiff('a\nb\n', 'a\nc\n')).toEqual([
      { sign: ' ', text: 'a' },
      { sign: '-', text: 'b' },
      { sign: '+', text: 'c' },
    ])
  })

  it('skips the inline diff above the size cap', () => {
    const big = `${'x\n'.repeat(120_000)}`
    const diff = lineDiff(big, `${big}y\n`)
    expect(diff).toHaveLength(1)
    expect(diff[0]?.text).toMatch(/too large/)
  })
})
