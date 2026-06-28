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

/** How the controller should react to one vault change (see {@link planVaultReaction}). */
export interface VaultReaction {
  /** Paths to re-hash via `engine.touch()` (drives the refresh debouncer). */
  touchPaths: string[]
  /** Whether to (re)arm the peer-bless ingest debouncer. */
  ingest: boolean
}

/**
 * Decide how to react to a vault change — pure, so it is unit-testable without
 * Obsidian (`main.ts` maps the result onto its debouncers).
 *
 * - A change under `<reviewFolder>/sync/` is a peer signal ⇒ ingest only.
 * - A content change ⇒ re-hash the touched path(s) AND re-arm ingest. The second
 *   part is the load-bearing bit: a peer bless is content-gated, so one that
 *   arrived before its (synced) bytes is *deferred* and retained; the bytes
 *   landing later is a plain content event (no sync-folder change), so without
 *   re-arming ingest here the obligation would never retry and the baseline would
 *   stay stuck until some unrelated future signal. A no-op ingest doesn't
 *   republish, so re-arming on every content change is cheap.
 * - An ignored path (the review folder, `.obsidian`) ⇒ do nothing.
 */
export function planVaultReaction(
  path: string,
  reviewFolder: string,
  oldPath?: string,
): VaultReaction {
  const syncDir = `${reviewFolder}/sync`
  if (path === syncDir || path.startsWith(`${syncDir}/`)) {
    return { touchPaths: [], ingest: true }
  }
  const touchPaths: string[] = []
  if (!shouldIgnorePath(path, reviewFolder)) touchPaths.push(path)
  if (oldPath && !shouldIgnorePath(oldPath, reviewFolder)) {
    touchPaths.push(oldPath)
  }
  return { touchPaths, ingest: touchPaths.length > 0 }
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
