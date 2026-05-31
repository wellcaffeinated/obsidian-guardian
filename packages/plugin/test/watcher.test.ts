import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDebouncer,
  createSerializedRefresh,
  shouldIgnorePath,
} from '../src/watcher'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('shouldIgnorePath', () => {
  it('ignores the review folder and its contents', () => {
    expect(shouldIgnorePath('_OG', '_OG')).toBe(true)
    expect(shouldIgnorePath('_OG/changes-abc.md', '_OG')).toBe(true)
  })
  it('ignores .obsidian config', () => {
    expect(shouldIgnorePath('.obsidian', '_OG')).toBe(true)
    expect(shouldIgnorePath('.obsidian/workspace.json', '_OG')).toBe(true)
  })
  it('does not ignore ordinary notes', () => {
    expect(shouldIgnorePath('notes/a.md', '_OG')).toBe(false)
    expect(shouldIgnorePath('_OG-not-the-folder.md', '_OG')).toBe(false)
  })
  it('respects a custom review folder', () => {
    expect(shouldIgnorePath('Review/changes.md', 'Review')).toBe(true)
    expect(shouldIgnorePath('_OG/changes.md', 'Review')).toBe(false)
  })
})

describe('createSerializedRefresh', () => {
  it('collapses calls made while a run is in flight into a single re-run', async () => {
    const resolvers: Array<() => void> = []
    let calls = 0
    const run = (): Promise<void> => {
      calls++
      return new Promise<void>((res) => resolvers.push(res))
    }
    const refresh = createSerializedRefresh(run)

    void refresh() // starts run #1
    void refresh() // in-flight → marks dirty
    void refresh() // still dirty
    expect(calls).toBe(1)

    resolvers[0]?.() // finish run #1 → dirty triggers exactly one re-run
    await tick()
    expect(calls).toBe(2)

    resolvers[1]?.() // finish run #2 → not dirty → stop
    await tick()
    expect(calls).toBe(2)
  })

  it('runs again for a call that arrives after the previous run settled', async () => {
    const resolvers: Array<() => void> = []
    let calls = 0
    const run = (): Promise<void> => {
      calls++
      return new Promise<void>((res) => resolvers.push(res))
    }
    const refresh = createSerializedRefresh(run)

    void refresh()
    resolvers[0]?.()
    await tick()
    expect(calls).toBe(1)

    void refresh()
    expect(calls).toBe(2)
    resolvers[1]?.()
    await tick()
    expect(calls).toBe(2)
  })
})

describe('createDebouncer', () => {
  afterEach(() => vi.useRealTimers())

  it('fires once after the quiet period regardless of how many schedules', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = createDebouncer(fn, 300)
    d.schedule()
    d.schedule()
    d.schedule()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(299)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancel() prevents a pending fire', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = createDebouncer(fn, 300)
    d.schedule()
    d.cancel()
    vi.advanceTimersByTime(1000)
    expect(fn).not.toHaveBeenCalled()
  })
})
