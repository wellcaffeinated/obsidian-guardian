# Mobile refresh robustness + startup perf

Tracking doc for the mobile "review state looks lost / panel won't update" issue.
Persisted so it survives across sessions. Branch: `fix/mobile-refresh-robustness`
(worktree `.worktrees/mobile-refresh`).

## Symptom (reported 2026-06-14)

On a **large** vault on **mobile**: start reviewing, do many blesses / advance
baseline — works in-session but the panel "has trouble updating." Close & reopen
Obsidian → panel shows the **uninitialized / "Start reviewing"** state; looks like
all history was lost. Reopening again later → state is back. The **test vault**
(small, older build `20260613`) is fine apart from showing the uninitialized
state "for a second or two" on open.

## Diagnosis (confirmed by reading the code, not a merge regression)

- **Data is not lost.** It persists in IndexedDB (LightningFS); it reappears on a
  later load. LightningFS awaits superblock load before every op
  (`PromisifiedFS.js:117/131`), so `isOnboarded()` returns the *true* answer once
  warm — no false "not onboarded" read race.
- **The merge introduced nothing.** `git diff c152bc1 9d592f1 -- packages/`
  (merge result vs feature-branch tip) is empty. The behavior shipped with the
  feature; it only bites at scale on mobile.

Three compounding root causes:

1. **No refresh serialization.** `createSerializedRefresh` (`watcher.ts:12`)
   exists + is unit-tested but is **never imported into `main.ts`** (line 34 only
   pulls `createDebouncer`/`shouldIgnorePath`). `init()`, `reloadTimeline()`,
   `flushEdits()`, `runIngest()`, `run()` (bless/checkpoint/rollback/restore),
   `firstBless()` can all overlap. Engine ops are multi-await, not atomic; the
   debouncers only delay start, they don't prevent overlap.

2. **No `loading` / `error` panel state.** `PanelData.active:false`
   (`format.ts:149`) renders identically (`review-view.ts:185`) whether the device
   was never activated OR is merely still loading OR errored. So the slow-load
   window actively tells the user "Start reviewing."

3. **Deferred-leaf update skip.** On mobile Obsidian restores the panel leaf
   *deferred*; `updateViews()` (`main.ts:466-471`) guards on
   `view instanceof ReviewView`, which is false for a deferred leaf, so the
   post-`init()` refresh is silently skipped. After that only a vault edit or a
   user action repaints. No `isDeferred`/`loadIfDeferred` handling anywhere.

4. **Startup `timeline()` is O((1+N)·M).** `timeline()` (`engine.ts:490`) calls
   `buildChanges()` for `current` + once per checkpoint (line 496). With
   `workIndex` null at startup, each falls back to `walkChanges`
   (`git-ops.ts:158`) which **reads + hashes every non-ignored file** (no
   stat/mtime shortcut). So startup = (1 + N_checkpoints) full vault walks, each
   hashing every file — over the slow mobile vault adapter. `ensureIndex()`
   (`engine.ts:619`) exists but is never called on the load path; priming it once
   makes `current` + all checkpoint diffs go through the in-memory
   `rawChangesFromIndex` (`engine.ts:607`). Collapses (1+N)·M → ~M reads.

## Tasks

### Easy fixes (robustness + legibility) — this branch
- [ ] Wire `createSerializedRefresh` (or one async mutex/queue) around every
      engine-touching path so init / refresh / ingest / user actions serialize.
- [ ] Add `loading` and `error` states to `PanelData` + render them distinctly
      in `ReviewView` (no more "Start reviewing" during load).
- [ ] Fix `updateViews()` for deferred leaves (use `leaf.isDeferred` /
      `leaf.loadIfDeferred()` instead of skipping non-`ReviewView` leaves); ensure
      a materializing `ReviewView` always pulls fresh post-init state.

### Profiling harness (bounded — never on the real vault) — DONE
- [x] Vitest profiler over a **synthetic** vault, both backends (node:fs and
      LightningFS via `fake-indexeddb`):
      `packages/engine/test/timeline-perf.profile.test.ts`, skipped unless
      `OG_PROFILE=1`. Resource-bounded runner: `scripts/profile-timeline.sh`
      (`pnpm profile:timeline`) — caps file/checkpoint counts, V8 heap, CPU
      seconds, and wall-clock. Measures onboard / cold timeline / rescan / warm
      timeline per backend and prints a table.

### Profiling findings (2026-06-14) — corrected the hypothesis
Measured (fake-indexeddb under-represents real mobile IDB, so treat as a *lower*
bound for `idb`):

| backend | files×cps | timeline COLD | rescan | timeline WARM |
|---------|-----------|---------------|--------|---------------|
| node:fs | 250×12    | 475ms         | 11ms   | 292ms         |
| idb     | 250×12    | 1000ms        | 10ms   | 350ms         |
| node:fs | 600×24    | 2172ms        | 28ms   | 1399ms        |
| idb     | 600×24    | 3371ms        | 25ms   | 2561ms        |

- Priming the work index (`ensureIndex`/`rescan`) is only a **~1.3–1.5×** win,
  NOT the dramatic gain first assumed. Confirmed `recover()`/`ingest()` never
  prime `workIndex`, so startup `timeline()` is genuinely the cold path — but the
  warm path is still slow.
- **Dominant cost: `timeline()` eagerly computes a full per-file diff for EVERY
  checkpoint** (`engine.ts buildChanges`): each changed file does a `readWorkdir`
  + `readMarkerBlob` + line-count `stats`, for all N checkpoints — even though the
  panel collapses checkpoint rows by default (`openCheckpoints` starts empty).
  Cost grows ~O(N²·churn) blob reads + O(N) `readFlatTree`.

### Perf optimization — DONE (commit on this branch)
- [x] **Defer per-checkpoint diffs** (high value): `timeline()` now ships a CHEAP
      per-checkpoint summary (kind + paths, no blob reads / line counting); the
      full per-file stats are fetched lazily on row expand via the new
      `engine.checkpointDiff(oid)` → `controller.checkpointChanges` → the view
      caches them and renders a brief "Loading changes…" placeholder. `current`
      (always shown) stays fully computed.
- [x] **Prime the index once**: `ensureIndex()` at the top of `timeline()` so the
      live diff + cheap summaries skip the per-checkpoint full working-tree walk.
- [ ] Optionally make startup `recover()` not block first paint (still open).

#### Before → after (`pnpm profile:timeline`, 600 files × 24 checkpoints)
| backend | startup timeline BEFORE | startup timeline AFTER | repeat (warm) | lazy expand (1 cp) |
|---------|-------------------------|------------------------|---------------|--------------------|
| node:fs | 2172ms                  | **214ms** (~10×)       | 173ms         | 141ms              |
| idb     | 3371ms                  | **865ms** (~4×)        | 222ms         | 140ms              |

The remaining `idb` startup cost (865ms) is the one unavoidable full-vault hash
scan (`ensureIndex`) over LightningFS + one cheap tree read per checkpoint; the
O((1+N)·M) blob reads are gone. Full per-file stats are paid only when the user
expands a specific checkpoint (~140ms), not at startup.

## Verification
- `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint`, `pnpm knip`, engine+plugin
  builds. Plugin behavior in the **headless container only** (never the user's
  real Obsidian) per CLAUDE.md.
