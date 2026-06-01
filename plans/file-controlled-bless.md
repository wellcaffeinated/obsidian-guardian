# Plan: file-controlled bless (bless via a synced markdown signal)

> **Status:** design only — not yet implemented.
> **Motivation:** let a device that only _syncs the vault_ (e.g. mobile, where
> the plugin/engine never runs) trigger a **bless** using nothing but a
> file-based signal. The guarantee to preserve: blessing applies to **exactly
> the reviewed state**, never silently absorbs newer unreviewed changes, and is
> robust to sync conflicts **without parsing any sync vendor's conflict files**
> (stay sync-agnostic).

## The problem

Turning the review note from a one-way output (watcher → human) into a two-way
channel (human → watcher) creates three hazards:

1. **Stale bless (the dangerous one).** A signal checked against the state at
   time _T_ syncs back seconds-to-minutes later; the agent may have written more
   (_T+1_). A naive `bless()` of the _current_ tree absorbs unreviewed changes —
   defeating the core guarantee.
2. **Write collision / lost signal.** If the watcher rewrites the same file the
   remote user is editing, it clobbers the signal or provokes a sync-conflict
   copy.
3. **Double / reordered processing.** A synced copy of a checked file can arrive
   more than once, or out of order relative to other signals.

## Load-bearing idea: bless a pinned snapshot, by oid

The bless signal references an **immutable snapshot commit**, not "now". Blessing
sets the trust marker to that snapshot's tree; anything written after the
snapshot stays pending. This makes bless:

- **correct under concurrency** (#1) — newer edits aren't in the snapshot;
- **idempotent / order-independent** (#3) — see the seq high-water-mark protocol.

We bless **by oid**, not by ref: the oid lives in the file's frontmatter, and
isomorphic-git's weak GC keeps a dangling commit object _readable_, so a delayed
bless whose checkpoint ref was already dropped still resolves.

## Snapshots = full states; the change list = a cumulative tree-diff

A **checkpoint** is a commit of the **whole tree** (git dedupes blobs, so a
whole-tree snapshot is near-free — only changed blobs + the tree objects along
changed paths + one small commit). It is never a delta on disk.

The change list rendered in the file is the **net tree-diff `baseline → snapshot`**
(cumulative), computed with the existing `walkChanges` machinery pointed at the
checkpoint instead of the workdir. Cumulative is mandatory because **bless is a
cumulative decision** ("accept everything since my last blessed state"); a
file-created-then-deleted between checkpoints correctly shows as _no change_.
Incremental "between-checkpoint" diffs are a different feature (the parked
timeline / auto-checkpointing view), out of scope here.

## Checkpoints are sibling-parented (not chained)

Each checkpoint's parent is the **current baseline** at the time it is taken (so
between blesses, `C1..Cn` are all children of `B`). Bless moves the `baseline`
marker to the chosen snapshot's tree.

Why siblings, not a chain `B←C1←…←Cn`:

- **Compact + reclaimable.** Blessing `C3` orphans `C1,C2,C4,C5` at once
  (none are ancestors of `C3`); baseline history accrues **one commit per bless**
  (the trusted timeline), and the unblessed candidates become dangling garbage.
- A chain would leave _every checkpoint ever made_ permanently reachable in
  baseline's ancestry (unbounded, unreclaimable).
- The parked recovery-timeline still works: the live candidates since the last
  bless are the checkpoint refs, ordered by their sortable id (a ref-list sort,
  per `plans/checkpoints-and-undo.md`).

> Note: this **supersedes** the earlier "chain them" instinct — chaining loses on
> the efficiency axis. Also supersedes the earlier "bless iff X is a _descendant_
> of baseline" idempotency idea: siblings aren't descendants, so ancestry is the
> wrong guard (see seq protocol below).

## Bless protocol: monotonic seq + non-synced high-water mark

Every snapshot carries a monotonic **`seq`** (a per-gitDir counter that only goes
up, stamped in the file's frontmatter). Guardian keeps a **high-water mark** =
the highest seq it has ever blessed, stored **in the gitDir** (never synced, so
it never conflicts). The rule:

> **Apply a bless for seq `S` iff `S > highWaterMark`; otherwise no-op.**

This makes the outcome **order-independent and idempotent** — the baseline ends
at the tree of the _highest-seq snapshot the user ever accepted_, regardless of
arrival order or duplicate syncs:

```
bless C3 (seq 3 > 0)  → baseline → v3, HWM = 3
bless C5 (seq 5 > 3)  → baseline → v5, HWM = 5     # naive double-bless: ends at v5 ✓

reversed / delayed:
bless C5 (seq 5 > 0)  → baseline → v5, HWM = 5
bless C3 (seq 3 > 5?) → NO-OP                       # would otherwise regress to v3 ✗
```

`bless(snapshotOid)` mechanically = make the baseline marker reflect that
snapshot's tree (point `baseline` at the snapshot commit, or commit its tree onto
the current baseline for a tidy one-commit-per-bless audit chain), then advance
the high-water mark. Bless **moves a pointer; it does not touch the working
tree** — the user's unblessed work stays on disk and is re-presented as pending.

## Sync-agnostic transport: rotating immutable files + retention grace

The signal channel must not rely on "the user probably won't edit while we
write" (hope-based) and must not parse vendor `.sync-conflict` files
(sync-coupling). So:

- **One immutable file per distinct snapshot.** Guardian _writes_ a file when a
  new snapshot appears and **never rewrites an existing file** — so it never
  collides with a file the user is editing. Filename embeds the per-replica guard
  and a short snapshot tag: `_OG/changes-<replica12>-<snap8>.md`.
- **Retention grace (~30s).** A superseded file is kept for a grace window before
  deletion, so any in-flight checkbox toggle has time to sync back. Steady state
  is ~1 file (plus any written within the grace window).
- **React to appear/change, not to conflict artifacts.** Guardian watches `_OG/`
  for files appearing or changing and reads the bless signal from their
  frontmatter. If a deleted-then-resurrected file reappears (delete-vs-edit on the
  sync layer), guardian simply re-reads it; the seq high-water mark makes
  reprocessing a harmless no-op. Convergent, vendor-neutral.

> Accepted trade-off (per user): rotating files cost a little `_OG/` churn and a
> GC pass, in exchange for staying sync-agnostic and never clobbering a
> user-edited file. The single-stable-file alternative was rejected as
> hope-based + requiring conflict-file scanning.

## File format

The bless control is a **frontmatter boolean** (`accepted`) — Obsidian renders it
as a checkbox toggle in the Properties panel. Heading is just `# Changes`.

Active (changes pending):

```markdown
---
vault: demo
accepted: false
snapshot: 7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a   # full 40-char oid; bless target
seq: 5                                               # monotonic; high-water guard
baseline: a1b2c3d                                    # current trusted short sha
baseline_at: 2026-06-01T10:00:00Z
updated_at: 2026-06-01T12:30:00Z
---

# Changes

3 changes from baseline:

- **modified** [[Notes/foo]] `+4 -1`
- **added** [[Notes/bar]] `+10 -0`
- **deleted** `Attachments/old.png` `binary`

Toggle **accepted** in the properties above to bless this snapshot as the new baseline.
```

Clean (nothing pending — `accepted` omitted, no checkbox to toggle):

```markdown
---
vault: demo
snapshot: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0
seq: 6
baseline: a1b2c3d
baseline_at: 2026-06-01T12:31:00Z
updated_at: 2026-06-01T12:31:00Z
---

# Changes

Nothing pending since the last blessed baseline.
```

Format decisions (locked):

- `snapshot` = full 40-char oid (unambiguous machine target); `baseline` = short
  human sha. Datetimes UTC ISO-8601 strings.
- `accepted` absent in the clean state (nothing to bless).
- Filename `changes-<replica12>-<snap8>.md`; full oid lives in frontmatter.

## Relationship to the checkpoint primitive

This consumes a **minimal slice** of `plans/checkpoints-and-undo.md`: snapshot the
reviewed tree to a checkpoint (sibling-parented on baseline), pin its oid, bless
by oid. The full ring / `undo` / retention-GC / CLI surface layer on later using
the same ref scheme (`refs/og/checkpoints/<sortable-id>`). Distinct axes remain:
`bless` advances the trust marker; checkpoints never do.

## Engine / adapter work (sketch)

> **Status:** the engine slice below is **built and green** (32 engine tests +
> existing CLI/plugin suites pass; typecheck/lint/knip/build clean; host
> `test:smoke` still passes). Implemented: `git-ops` primitives
> (`writeRef`/`commitIndex`/`commitTree`/`readTreeOid`/`readCommitTime`),
> `state.ts` (non-synced `snapshot-seq` + `bless-hwm` counters under the gitDir),
> `ReviewEngine.checkpoint()/blessSnapshot()/snapshot()`, the `SnapshotStatus`
> type, `renderChangesFile()`, and `changesFileName()`. `refresh()` and the
> watcher are intentionally **not** rewired yet — that's the next (CLI/watcher)
> slice, which is where the rotating-file orchestration, the `_OG/` external-edit
> detection, and the smoke-level assertions land.

Engine (pure, `packages/engine`):

- `checkpoint()` — commit current tree as a sibling checkpoint of baseline;
  assign + persist a monotonic `seq`; return `{ oid, seq }`. No-op-safe when the
  tree equals baseline (clean state still gets a snapshot id for the file).
- `blessSnapshot(oid, seq)` — apply iff `seq > highWaterMark` (HWM persisted in
  gitDir); set baseline to the snapshot's tree; advance HWM. Idempotent.
- Render: change list as cumulative `baseline → snapshot` tree-diff + the new
  frontmatter (`accepted`, `snapshot`, `seq`, `baseline`, `baseline_at`,
  `updated_at`). Reuse `walkChanges` against the checkpoint ref.
- HWM + seq counter live under the gitDir (e.g. alongside `replica-id`), never
  synced.

Watcher/adapter (`packages/cli` watch, later plugin):

- On content change: `checkpoint()`, write the new rotating file, schedule
  deletion of superseded files after the grace window.
- Watch `_OG/` for files appearing/changing; on `accepted: true`, read
  `snapshot`+`seq`, call `blessSnapshot`, refresh, clean the consumed file.
- Distinguish own writes from external (synced) edits so writing a rotating file
  doesn't self-trigger (today the watcher ignores `_OG/` wholesale — this must
  narrow to "ignore my own writes, react to external edits").

## Race conditions — resolution summary

| Race | Resolution |
| --- | --- |
| Stale bless (tree moved on) | bless pins the snapshot oid; newer edits stay pending |
| Write collision on the signal file | immutable per-snapshot files; guardian never rewrites one |
| Sync-conflict artifacts | never parsed; we react to appear/change + idempotent reprocess |
| Double / reordered signals | seq high-water mark: apply iff `seq > HWM` |
| Delayed bless after ref GC | bless by oid; dangling commit stays readable |
| GC vs in-flight bless | checkpoint GC is gitDir-only (never synced); + grace window on files |
| HWM regression | HWM stored in gitDir, never synced — no cross-device contention |

## Test plan (when implemented)

Engine (Vitest against `src`):

- `checkpoint()` assigns strictly increasing seq; equal-tree checkpoint is
  no-op-safe.
- `blessSnapshot` applies for `seq > HWM`, no-ops otherwise (covers double-bless
  C3-then-C5 → ends at v5; reversed C5-then-C3 → no regression; duplicate seq →
  no-op).
- bless sets baseline to the snapshot tree and leaves the working tree untouched;
  pending recomputes as `newBaseline → workdir`.
- rendered file frontmatter shape (active vs clean) + cumulative diff (a
  create-then-delete between checkpoints shows no change).

Smoke (`scripts/`):

- Watch path: edit → rotating file written; toggle `accepted: true` in the file →
  baseline advances, file consumed/cleaned; superseded files removed after grace.
- Reordered/duplicate signal asserted via a stale file toggle → no-op.

## Out of scope

- Per-file accept (this is all-or-nothing bless to start).
- Full checkpoints `undo` / ring GC / CLI surface (separate plan; same refs).
- Object repacking / hard disk reclamation (defer; mark-sweep prune later if the
  loose-object count ever matters — no git binary in the slim container).
