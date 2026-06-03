import { contextualDiff, lineDiff, lineStats } from '@obsidian-guardian/engine'
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

describe('contextualDiff', () => {
  it('collapses unchanged lines outside the context window', () => {
    // 10 unchanged lines, change on line 5 (0-indexed), context=1
    const lines = lineDiff(
      Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'),
      Array.from({ length: 10 }, (_, i) =>
        i === 5 ? 'CHANGED' : `line${i}`,
      ).join('\n'),
    )
    const result = contextualDiff(lines, 1)
    // 5 leading context lines, 1 kept → snip covers 4; 4 trailing, 1 kept → snip covers 3
    expect(result[0]).toEqual({ sign: '~', text: '⋯ 4 lines' })
    expect(result.at(-1)).toEqual({ sign: '~', text: '⋯ 3 lines' })
    const signs = result.map((l) => l.sign)
    expect(signs).toEqual(['~', ' ', '-', '+', ' ', '~'])
  })

  it('merges windows when two hunks are within 2*context lines of each other', () => {
    // Changes on line 0 and line 4 with context=3: windows overlap, no snip between
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const after = ['A', 'b', 'c', 'd', 'E', 'f', 'g', 'h'].join('\n')
    const lines = lineDiff(before, after)
    const result = contextualDiff(lines, 3)
    expect(result.every((l) => l.sign !== '~')).toBe(true)
  })

  it('emits a snip between distant hunks', () => {
    const rows = Array.from({ length: 20 }, (_, i) => `line${i}`)
    const after = [...rows]
    after[0] = 'CHANGED'
    after[19] = 'CHANGED'
    const lines = lineDiff(rows.join('\n'), after.join('\n'))
    const result = contextualDiff(lines, 2)
    const snips = result.filter((l) => l.sign === '~')
    expect(snips).toHaveLength(1) // one snip between the two distant hunks
  })

  it('returns unchanged diff when there are no context-only lines to collapse', () => {
    const lines = lineDiff('a\n', 'b\n')
    expect(contextualDiff(lines, 3)).toEqual(lines)
  })

  it('returns empty for an empty input', () => {
    expect(contextualDiff([], 3)).toEqual([])
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
