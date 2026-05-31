import type { ChangeEntry, Status } from '@obsidian-guardian/engine'
import { describe, expect, it } from 'vitest'
import { describeStatus, formatStats, shortMarker } from '../src/format'

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

const status: Status = {
  marker: 'abcdef1234567890',
  generatedAt: '2026-05-31T00:00:00.000Z',
  clean: false,
  changes: [added, modified, renamed, binaryAdd],
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

describe('describeStatus', () => {
  it('produces one row per change with view-ready fields', () => {
    const rows = describeStatus(status)
    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      kind: 'add',
      path: 'a.md',
      markdown: true,
      stats: '+10 -0',
    })
    expect(rows[2]).toMatchObject({
      kind: 'rename',
      from: 'old.md',
      stats: '+0 -0',
    })
    expect(rows[3]).toMatchObject({ markdown: false, stats: 'binary' })
  })
})
