/**
 * Framework-agnostic refresh plumbing, ported from the CLI watcher
 * (`packages/cli/src/watch.ts`). Kept free of Obsidian imports so it is unit
 * testable; `main.ts` wires these to `app.vault` events.
 */

/**
 * Wrap an async refresh so concurrent calls collapse: if a run is in progress,
 * the caller marks the run "dirty" and the in-flight run loops once more when it
 * finishes. Guarantees the final state is always captured without overlapping runs.
 */
export function createSerializedRefresh(
  run: () => Promise<unknown>,
): () => Promise<void> {
  let running = false
  let dirty = false
  return async (): Promise<void> => {
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      do {
        dirty = false
        await run()
      } while (dirty)
    } finally {
      running = false
    }
  }
}

/**
 * True for vault paths the watcher must never react to. Rendering the review
 * note writes under `reviewFolder`; reacting to that would refresh forever.
 * `.obsidian` (workspace/plugin state) is likewise irrelevant to the review.
 */
export function shouldIgnorePath(path: string, reviewFolder: string): boolean {
  if (path === reviewFolder || path.startsWith(`${reviewFolder}/`)) return true
  if (path === '.obsidian' || path.startsWith('.obsidian/')) return true
  return false
}

/** A trailing-edge debouncer: `schedule()` (re)arms the timer; `cancel()` clears it. */
export interface Debouncer {
  schedule: () => void
  cancel: () => void
}

/** Create a {@link Debouncer} that runs `fn` `ms` after the last `schedule()`. */
export function createDebouncer(fn: () => void, ms: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    schedule(): void {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        fn()
      }, ms)
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = undefined
    },
  }
}
