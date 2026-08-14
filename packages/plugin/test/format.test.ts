import type { ChangeEntry, Timeline } from '@obsidian-guardian/engine'
import { describe, expect, it } from 'vitest'
import {
  buildPanelData,
  formatStats,
  partitionHistoryByCount,
  reverseFileRow,
  shortMarker,
  staleDiffKeys,
  toFileRow,
} from '../src/format'

const added: ChangeEntry = {
  path: 'a.md',
  kind: 'add',
  added: 10,
  removed: 0,
  binary: false,
}
const modified: ChangeEntry = {
  path: 'b.md',
  kind: 'modify',
  added: 5,
  removed: 3,
  binary: false,
}
const renamed: ChangeEntry = {
  path: 'new.md',
  kind: 'rename',
  renamedFrom: 'old.md',
  added: 0,
  removed: 0,
  binary: false,
}
const binaryAdd: ChangeEntry = {
  path: 'img.png',
  kind: 'add',
  added: 0,
  removed: 0,
  binary: true,
}

describe('formatStats', () => {
  it('formats line counts and binary', () => {
    expect(formatStats(added)).toBe('+10 -0')
    expect(formatStats(binaryAdd)).toBe('binary')
  })
})

describe('shortMarker', () => {
  it('shortens a sha and handles none', () => {
    expect(shortMarker('abcdef1234567890')).toBe('abcdef1')
    expect(shortMarker(null)).toBe('none')
  })
})

describe('toFileRow', () => {
  it('splits dir/name and marks markdown + stats', () => {
    expect(toFileRow(modified)).toMatchObject({
      kind: 'modify',
      path: 'b.md',
      dir: '',
      name: 'b.md',
      markdown: true,
      stats: '+5 -3',
      added: 5,
      removed: 3,
      binary: false,
    })
    const nested: ChangeEntry = {
      path: 'Projects/Roastery.md',
      kind: 'modify',
      added: 1,
      removed: 0,
      binary: false,
    }
    expect(toFileRow(nested)).toMatchObject({
      dir: 'Projects/',
      name: 'Roastery.md',
    })
  })
})

describe('reverseFileRow', () => {
  it('flips add↔delete, swaps +/- counts, and rewrites stats', () => {
    expect(reverseFileRow(toFileRow(added))).toMatchObject({
      kind: 'delete',
      added: 0,
      removed: 10,
      stats: '+0 -10',
    })
    expect(reverseFileRow(toFileRow(modified))).toMatchObject({
      kind: 'modify',
      added: 3,
      removed: 5,
      stats: '+3 -5',
    })
  })

  it('flips a rename’s endpoints (path ↔ from)', () => {
    expect(reverseFileRow(toFileRow(renamed))).toMatchObject({
      kind: 'rename',
      path: 'old.md',
      name: 'old.md',
      from: 'new.md',
    })
  })

  it('keeps binary rows as binary', () => {
    expect(reverseFileRow(toFileRow(binaryAdd))).toMatchObject({
      kind: 'delete',
      binary: true,
      stats: 'binary',
    })
  })
})

describe('buildPanelData', () => {
  it('returns an empty inactive shell when no timeline', () => {
    const data = buildPanelData({ active: false, timeline: null })
    expect(data).toMatchObject({
      active: false,
      baseline: null,
      current: [],
      checkpoints: [],
      peers: null,
    })
  })

  it('maps a timeline into baseline + current + checkpoint rows', () => {
    const timeline: Timeline = {
      baseline: {
        oid: 'abcdef1234567890',
        when: '2026-05-31T00:00:00.000Z',
        tree: 'tree-baseline',
      },
      current: [added, modified],
      checkpoints: [
        {
          oid: '9f3a1c2deadbeef0',
          tree: 'tree-checkpoint',
          seq: 2,
          when: '2026-05-31T01:00:00.000Z',
          changes: [renamed],
        },
      ],
    }
    const data = buildPanelData({
      active: true,
      timeline,
      peers: { count: 2, updatedAt: '2026-05-31T02:00:00.000Z' },
    })
    expect(data.active).toBe(true)
    expect(data.baseline).toEqual({
      shortHash: 'abcdef1',
      when: '2026-05-31T00:00:00.000Z',
      tree: 'tree-baseline',
    })
    expect(data.current.map((r) => r.path)).toEqual(['a.md', 'b.md'])
    expect(data.checkpoints).toHaveLength(1)
    expect(data.checkpoints[0]).toMatchObject({
      oid: '9f3a1c2deadbeef0',
      tree: 'tree-checkpoint',
      shortHash: '9f3a1c2',
      seq: 2,
    })
    expect(data.checkpoints[0]?.changes[0]).toMatchObject({
      kind: 'rename',
      from: 'old.md',
    })
    expect(data.peers).toEqual({
      count: 2,
      updatedAt: '2026-05-31T02:00:00.000Z',
    })
  })

  it('derives status from active when not given (and defaults error null)', () => {
    expect(buildPanelData({ active: false, timeline: null })).toMatchObject({
      status: 'inactive',
      error: null,
    })
    expect(
      buildPanelData({
        active: true,
        timeline: {
          baseline: { oid: null, when: null, tree: null },
          current: [],
          checkpoints: [],
        },
      }).status,
    ).toBe('ready')
  })

  it('passes through an explicit status + error (loading/error panels)', () => {
    expect(
      buildPanelData({ active: false, timeline: null, status: 'loading' })
        .status,
    ).toBe('loading')
    const errored = buildPanelData({
      active: false,
      timeline: null,
      status: 'error',
      error: 'boom',
    })
    expect(errored.status).toBe('error')
    expect(errored.error).toBe('boom')
  })
})

describe('staleDiffKeys', () => {
  it('evicts closed rows and keeps open ones (they are re-validated in place)', () => {
    const cached = ['__baseline__:a.md', '__baseline__:b.md', 'abc123:c.md']
    const open = new Set(['__baseline__:b.md'])
    expect(staleDiffKeys(cached, open)).toEqual([
      '__baseline__:a.md',
      'abc123:c.md',
    ])
  })

  it('keeps nothing when no row is open', () => {
    expect(staleDiffKeys(['x:1.md', 'y:2.md'], new Set())).toEqual([
      'x:1.md',
      'y:2.md',
    ])
  })

  it('evicts nothing when every cached row is open', () => {
    const open = new Set(['x:1.md', 'y:2.md'])
    expect(staleDiffKeys(['x:1.md', 'y:2.md'], open)).toEqual([])
  })

  it('accepts a Map keys() iterator (the live cache shape)', () => {
    const diffs = new Map([
      ['x:1.md', { binary: false, lines: [] }],
      ['y:2.md', { binary: false, lines: [] }],
    ])
    expect(staleDiffKeys(diffs.keys(), new Set(['y:2.md']))).toEqual(['x:1.md'])
  })
})

describe('partitionHistoryByCount', () => {
  const ids = (rows: Array<{ id: number }>) => rows.map((r) => r.id)
  const seq = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }))

  it('keeps the newest `limit` entries and collapses the rest', () => {
    const { recent, older } = partitionHistoryByCount(seq(6), { limit: 2 })
    expect(ids(recent)).toEqual([0, 1])
    expect(ids(older)).toEqual([2, 3, 4, 5])
  })

  it('collapses nothing when the list is at or under the limit', () => {
    const { recent, older } = partitionHistoryByCount(seq(3), { limit: 10 })
    expect(ids(recent)).toEqual([0, 1, 2])
    expect(older).toEqual([])
  })

  it('treats limit <= 0 as "no cutoff"', () => {
    for (const limit of [0, -1]) {
      const { recent, older } = partitionHistoryByCount(seq(5), { limit })
      expect(recent).toHaveLength(5)
      expect(older).toEqual([])
    }
  })

  it('keeps pinned entries past the limit, in addition to it', () => {
    const entries = [
      { id: 0, isBaseline: false },
      { id: 1, isBaseline: false },
      { id: 2, isBaseline: false },
      { id: 3, isBaseline: true },
      { id: 4, isBaseline: false },
    ]
    const { recent, older } = partitionHistoryByCount(entries, {
      limit: 2,
      pinned: (e) => e.isBaseline,
    })
    // The pin is additive: two newest PLUS the pinned straggler.
    expect(ids(recent)).toEqual([0, 1, 3])
    expect(ids(older)).toEqual([2, 4])
  })

  it('loses nothing — the two halves always cover the input', () => {
    const { recent, older } = partitionHistoryByCount(seq(7), { limit: 3 })
    expect(recent.length + older.length).toBe(7)
  })
})
