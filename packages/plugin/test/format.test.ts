import type { ChangeEntry, Timeline } from '@obsidian-guardian/engine'
import { describe, expect, it } from 'vitest'
import {
  buildPanelData,
  formatStats,
  shortMarker,
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
      },
      current: [added, modified],
      checkpoints: [
        {
          oid: '9f3a1c2deadbeef0',
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
    })
    expect(data.current.map((r) => r.path)).toEqual(['a.md', 'b.md'])
    expect(data.checkpoints).toHaveLength(1)
    expect(data.checkpoints[0]).toMatchObject({
      oid: '9f3a1c2deadbeef0',
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
})
