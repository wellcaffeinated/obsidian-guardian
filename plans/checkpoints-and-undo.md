# Plan: checkpoints + undo (data-loss safety net)

> **Status:** design only — not yet implemented.
> **Motivation:** close a hole in the core guarantee (_"complete visibility +
> clean undo, not prevention"_). Today `rollback`/`revert` are the only
> operations with no undo — they overwrite the working tree from `baseline` and
> commit nothing of the pre-op state, so unblessed work is destroyed
> irrecoverably.

## Problem

`ReviewEngine.rollback()` and `revert(path)` both funnel into the private
`restore()` (`packages/engine/src/engine.ts`). `restore()` writes the baseline
blob bytes over the working-tree file (or deletes it) and syncs the index. The
**only** ref in the repo is `baseline`. Nothing captures the working tree _as it
was_ before the destructive op, so:

- A panic `rollback` after an agent run throws away every unblessed change with
  no recovery path.
- A `revert <path>` silently discards the current content of that one file.

This is the inverse of what the tool promises.

## Core idea: the checkpoint primitive

A **checkpoint** is a commit that captures the current working tree **without
moving `baseline`**. It is the missing primitive, and it doubles as the
foundation for the parked auto-checkpointing feature (a debounced timer would
call the same primitive).

- Checkpoints live **in the gitDir**, outside the synced vault → they never sync
  to other devices. Purely a local safety net.
- Git dedupes blobs, so snapshotting the whole tree before a destructive op is
  near-free.
- Checkpoints do **not** advance the trust marker. `baseline` = "last reviewed"
  stays put; checkpoints are an orthogonal recovery timeline.

### Refs

- `refs/og/checkpoints/<sortable-id>` — one ref per checkpoint. `<sortable-id>`
  is a lexicographically-sortable timestamp (e.g. `2026-05-31T14-22-09-123Z` or
  a monotonic counter) so "most recent" is a ref-list sort, no commit-graph walk
  needed.
- Each checkpoint commit message records provenance:
  `checkpoint: pre-rollback` / `checkpoint: pre-revert <path>` /
  `checkpoint: auto` (future timer).

### Engine API (proposed)

```ts
// Snapshot the current work-tree to a new checkpoint ref. Returns its id.
// Does NOT move the baseline marker. No-op-safe: always creates a ref even if
// the tree equals baseline (so "undo" has something to land on).
checkpoint(reason: string): Promise<string>

// List checkpoints, newest first (id + timestamp + reason + short sha).
checkpoints(): Promise<CheckpointEntry[]>

// Restore the work-tree to a checkpoint (default: most recent). Two-way sync
// (see below). Does NOT delete the checkpoint or move baseline.
undo(checkpointId?: string): Promise<void>
```

`CheckpointEntry` is a new public type re-exported from
`packages/engine/src/index.ts` (named export, per repo convention).

## Behavioural changes

**Auto-checkpoint before every destructive op.** Both `rollback()` and
`revert(path)` call `checkpoint('pre-…')` _first_, then proceed as today. (Per
decision: _all_ destructive ops checkpoint, not just rollback — one whole-tree
checkpoint regardless of which op, so single-file `revert` is recoverable too,
independent of Obsidian's native file history.)

```
rollback():  checkpoint('pre-rollback')        → restore whole tree from baseline
revert(p):   checkpoint(`pre-revert ${p}`)     → restore path p from baseline
undo():      restore whole tree from latest checkpoint  (baseline untouched)
```

Because rollback/revert never move `baseline`, `undo` only touches the working
tree. After `undo`, pending re-appears exactly as it was before the destructive
op — symmetric and lossless.

## Restore must be a TRUE two-way tree sync

This is the subtle correctness point. The current per-path `restore()` only
writes/deletes the paths that `walkChanges(baseline ↔ workdir)` reports.
Restoring a _whole snapshot_ (undo) must, relative to the checkpoint tree:

- **re-create** files the destructive op deleted (present in checkpoint, absent
  now), and
- **remove** files absent in the checkpoint but present now.

Implementation: reuse `walkChanges`, but pointed at the **checkpoint ref**
instead of `baseline`, walking `checkpoint ↔ workdir` in both directions, then
apply each delta with the existing blob-write / `rm` logic. (`GitCtx.ref` is
already parameterised; the walk just needs to target an arbitrary ref.) Respect
the same ignore matcher so `_OG/` and `.obsidian` caches aren't touched.

## CLI surface

- `og undo` — restore the latest checkpoint (the headline "undo my rollback").
- `og undo --to <id>` — restore a specific checkpoint.
- `og checkpoints` — list recovery points (`--json` for machine output).
- `og checkpoint [--reason <r>]` — manual snapshot (optional; cheap).
- All of these `refresh()` the review note afterward, like bless/revert/rollback
  do today (one-shot management commands keep the note correct without a
  watcher).

## Retention / GC

- Bound the ring: keep the **last N** checkpoints (config, default e.g. 50)
  and/or a time window. On each new checkpoint, delete refs beyond the bound.
- isomorphic-git has weak GC, so: dropping refs is enough for correctness;
  orphaned objects dangle harmlessly. Defer real repacking — note it as a known
  follow-up, same posture as the existing "optimise with a stat cache later".
- Checkpoints in the gitDir don't sync, so growth is local-only and capped by
  the ring.

## Relationship to existing concepts

- **vs. `bless`** — bless _advances_ `baseline`; checkpoints never do. Distinct
  axes (trust marker vs. recovery timeline).
- **vs. `tag`** — `tag` is a _named, intentional_ snapshot at the marker;
  checkpoints are _automatic, ephemeral_ snapshots of the working tree, ring-
  bounded.
- **vs. auto-checkpointing (parked feature)** — same primitive. This plan builds
  `checkpoint()` + `undo()` + manual/ pre-op triggers; the timer-driven variant
  is a later, additive trigger on top (debounced periodic `checkpoint('auto')`),
  plus a richer "restore to arbitrary point" UX. Auto-_bless_ remains explicitly
  excluded (it would silently absorb unreviewed changes).

## Test plan (when implemented)

Engine (Vitest against `src`):

- `rollback` then `undo` round-trips the working tree exactly (adds, modifies,
  deletes, renames) and leaves `baseline` unchanged.
- `revert(path)` then `undo` restores that file's pre-revert content.
- `undo` removes files that were created _after_ the checkpoint (two-way sync).
- Ignored paths (`_OG/`, `.obsidian` caches) are untouched by `undo`.
- Ring retention drops the oldest ref past the bound; `checkpoints()` ordering
  is newest-first.

Smoke (`scripts/`):

- Extend `test:smoke` with a rollback → undo lifecycle assertion against the
  built CLI (and `--json` for `checkpoints`).

## Out of scope for this plan

- Timer-driven auto-checkpointing (additive trigger; separate plan).
- Plugin/panel UI for browsing + restoring checkpoints (engine API lands first;
  the desktop panel and a mobile-readable recovery list come later).
- Object repacking / aggressive GC.
