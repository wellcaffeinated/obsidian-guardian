# P2P bless protocol — symmetric, sync-coordinated review

> **Status: planning sketch.** Data shapes + pseudo-protocol for pressure-testing
> _before_ committing to a repo/pivot. Not yet a build spec.

## Product shape (what we're actually building)

A **first-class Obsidian plugin with a real UI panel** — diff of changes since
baseline, per-file/whole bless, rollback, and checkpoint history — running with
**full support on mobile and desktop** (no `isDesktopOnly`). The synced
human-readable "changes note" of the old design is **gone**; the plugin renders
the diff UI directly from synced JSON.

Down the road the engine could become a **standalone change-review utility,
storage-agnostic** (git is one backend, not a hard dependency). We don't build
that now, but we keep the storage interface narrow so it stays possible.

## What this replaces

The client/server model (one device owns the canonical gitDir; others view a
synced note) becomes **symmetric**: every device runs the engine over its **own
local, never-synced git**, and devices coordinate the _trust marker_ — not git
state — through a handful of **synced JSON signal files** in the vault.

Locked invariants that survive the pivot:

- **Git never syncs.** Each device's gitDir is device-local storage outside the
  synced tree. The only cross-device channel is the synced signal files.
- **Content travels via Obsidian Sync as real files**, not via git. A bless
  carries only _hashes_; a receiving device matches them against its own synced
  working tree, and it already _has_ the bytes.
- Ignores via `.git/info/exclude`.

## Core model in one paragraph

A **checkpoint** is a content snapshot (a local git commit) with a monotonic
per-client sequence number, made on a debounced batch or on manual request. A
**bless** approves a defined checkpoint, serialized as a **delta manifest of
absolute content hashes** into a synced file. Each device applies a received
bless **per file**: advance its baseline for a path only where its own synced
working tree _already hashes to that value_. That single **content gate** is the
whole conflict-resolution story — the post-sync working tree is the arbiter, so
the apply rule is idempotent, commutative, and convergent (a per-path
last-writer-wins register, content-keyed) with **no vector clock**. Baselines on
different devices need not be equal — only the _approved content_ converges.

### Why no vector clock (and no CRDT library)

The content gate subsumes every job a clock would do.

- **Concurrent blesses of the same path** can only carry _different_ hashes if
  the blessers saw different content (sync hadn't converged). The gate admits
  only the bless whose hash equals the **current** working tree — the content
  **Obsidian Sync itself already chose**. There is no independent "which bless
  wins"; the content already won, the bless just ratifies it.
- **The "causal cut"** (a peer blessed a checkpoint older than my latest local
  change) falls out for free: my newer edit has a hash the blesser never saw, so
  its manifest entry is absent or fails the gate → that path stays pending.

The one thing a clock could _uniquely_ do is reject a stale-but-content-matching
bless (**ABA**: a month-old `(F,h1)` re-applies because `F` cycled back to `h1`).
A human did approve those exact bytes, so re-ratifying is defensible; if we want
conservative "make me re-review," a **freshness window** (§6) buys it far more
cheaply than a clock.

A **CRDT library** (Yjs/Automerge) is overkill and a poor fit: our signal files
are single-writer (one per client, §invariant), Obsidian Sync is the transport,
and the "merge" is a deterministic reader-side fold — not multi-writer document
replication. A CRDT lib would re-introduce state/version vectors (the clocks we
removed) plus opaque binary state. The "CRDT shape" (§5) is the convergence
_argument_, not a dependency.

---

## Storage model (git as the backend, two refs)

Everything content-addressed lives in a **device-local object store that never
syncs and never lives inside the vault** — a dot-folder dodges Obsidian Sync, but
iCloud / Syncthing / Obsidian-Git would still replicate anything under the vault
root, so the store goes in OS app-data (desktop) or IndexedDB (mobile), never in
the tree. Because each store is private to its device, **only the content `Hash`
must agree across devices — the on-disk format need not**, which is what lets
mobile skip isomorphic-git entirely.

**Dependency-injected storage (DRY across environments).** The engine depends on
**two injected interfaces**, never on `node:fs` directly — because two
filesystems with opposite requirements are in play:

```ts
/** The synced vault = the working tree. */
interface WorkingTree {
  list(): Promise<Path[]>;             // non-ignored paths
  read(p: Path): Promise<Uint8Array>;
  write(p: Path, bytes: Uint8Array): Promise<void>;
  remove(p: Path): Promise<void>;
  exists(p: Path): Promise<boolean>;
}

/** The git object/ref db = device-local, NEVER synced. */
interface ObjectStore {
  writeBlob(bytes: Uint8Array): Promise<Hash>;
  readBlob(h: Hash): Promise<Uint8Array>;
  writeTree(entries: Array<[Path, Hash | "tree"]>): Promise<Hash>;
  readTree(h: Hash): Promise<Array<[Path, Hash]>>;
  commit(tree: Hash, parents: Hash[], msg: string): Promise<Hash>;
  getRef(name: string): Promise<Hash | null>;
  setRef(name: string, commit: Hash): Promise<void>; // atomic
}
```

| Env | `WorkingTree` | `ObjectStore` backend |
| --- | --- | --- |
| CLI / container | `node:fs` at vault path | isomorphic-git over `node:fs` folder |
| Plugin (desktop) | `app.vault.adapter` | isomorphic-git over `node:fs` folder |
| Plugin (mobile) | `app.vault.adapter` (works on mobile) | **isomorphic-git over IndexedDB** (`fs.promises` shim) + Buffer polyfill; Merkle KV as fallback |

Why this split (not a single injected `fs`): isomorphic-git uses **one fs for
both worktree and gitdir**, which is unsatisfiable on mobile (no path "outside
the vault" for a gitDir). Treating `ObjectStore` as a pure object-db over its own
fs, and reading the worktree separately via `WorkingTree`, sidesteps that — and
on mobile the gitDir lives in **IndexedDB, which is device-local and unsynced by
construction** (no sandbox escape, no Sync-exclude config, no risk of git data
leaking into sync). This matches choices already made (engine hashes working-tree
files itself; revert/rollback write blob bytes directly rather than
`git.checkout`). It's also the seam for the future **non-git** backend (another
`ObjectStore` impl).

**Mobile uses isomorphic-git too — parity restored.** `obsidian-git` proves
isomorphic-git runs on Obsidian iOS/Android: it passes a custom `fs.promises`
shim over `app.vault.adapter` to isomorphic-git, and fixes the one real blocker
(`Buffer` absent in the mobile WKWebView) with a 6-line `polyfill_buffer.js`
injected at bundle time. So our `ObjectStore` is **isomorphic-git on every
platform** (the original parity goal — no hand-rolled git), differing only in the
backing `fs`:

- **Desktop/CLI** → `node:fs` (a real git repo, full tooling interop).
- **Mobile** → an **IndexedDB-backed `fs.promises`** (LightningFS or a small
  equivalent).

**Implementation mechanism — a composite routing `fs` (chosen for Phase 1).**
isomorphic-git wants *one* `fs` for both worktree and gitdir. Rather than rewrite
the engine to a from-scratch object-db, inject a single `FsClient` that **routes
by path**: paths under the worktree → the worktree backend, paths under the
gitdir → the gitdir backend. The existing, tested engine/git-ops logic is reused
**unchanged**; only the injected `fs` differs per platform:

| | worktree backend | gitdir backend |
| --- | --- | --- |
| Desktop/CLI | `node:fs` | `node:fs` (app-data folder) |
| Mobile | `app.vault.adapter` (as `fs.promises`) | LightningFS / IndexedDB |

So `WorkingTree` and `ObjectStore` are realised as the **two backends behind the
router**, not a hand-rolled git. Engine work (Phase 1): thread an injected `fs`
through `git-ops`/`engine` (default `node:fs`), converting the few remaining sync
fs calls to async (mobile adapters are async-only). The from-scratch Merkle KV
stays a deep fallback only if LightningFS fails the iOS spike.

Why IndexedDB and *not* obsidian-git's adapter-files-in-the-vault approach: those
files **leak to iCloud/Syncthing** (which, unlike Obsidian Sync, don't skip
dot-folders), and syncing per-device git stores would collide their mutable refs
→ corruption. IndexedDB sits outside **every** sync backend. Its cost is iOS
eviction under storage pressure — neutralised by **re-bootstrap** (§boundary
cases): synced bless records rebuild the baseline; only unblessed checkpoint
history is lost. A ~100-line Merkle KV (`writeBlob/readBlob`, `writeTree`,
`commit`, `get/setRef`) is the deep fallback if isomorphic-git-over-IndexedDB
fails the spike — git's tiny core, not a git reimplementation.

Two refs per device:

- **`baseline`** — a commit whose tree = the blessed content of the whole vault.
  This is the trust marker. Its first-parent ancestry is the **blessed-state
  history** (§ retention #8). Advancing baseline = build a new tree (old baseline
  tree with the blessed paths overlaid from the working tree's blobs), commit,
  **move the ref last in one atomic step**.
- **`checkpoints`** — debounced/manual snapshots of the _full working tree_
  (blessed or not). These are the **restore points** for rollback and the
  undo-a-rollback window (§ retention #9).

A user rollback to checkpoint `X` = set working tree to `X` **and** advance
baseline to `X` (auto-bless — §4 revert/rollback).

---

## Identifiers & primitives

```ts
/** Stable per-device id. Random UUID persisted in the (non-synced) gitDir.
 *  NEVER a synced setting — a shared id would collide every device onto one
 *  signal file. */
type ClientId = string; // e.g. "c_9f3a…"

/** Content address of a file's bytes: the git blob sha (sha1 of
 *  "blob <len>\0<bytes>"), computed by isomorphic-git on every platform (the
 *  parity goal). The cross-device coordination currency — identical everywhere
 *  for identical bytes; path- and history-independent. Each device's object
 *  store is private, so only the *hash* must agree, not the storage layout. */
type Hash = string;

/** Monotonic per-client counter. Increments once per checkpoint / per bless.
 *  Used only for dedup, freshness, and GC — NEVER in the apply rule. */
type Seq = number;

type Path = string; // vault-relative posix path

/** Explicit deletion sentinel — NOT null. Omission from a manifest means
 *  "unchanged from baseline", so a delete must be stated. A hex hash can never
 *  collide with this literal. */
const DELETED = "DELETED" as const;
```

### Manifest entry — delta with absolute hashes, plus explicit tombstones

```ts
interface ManifestEntry {
  path: Path;
  hash: Hash | typeof DELETED; // DELETED ⇒ this path was removed
}

/** Delta only: paths the blesser perceived as changed from ITS baseline.
 *  Inclusion is baseline-relative; the hash value is absolute. That split lets a
 *  receiver with a *different* baseline still apply it. */
type Manifest = ManifestEntry[];
```

---

## Synced signal files (the only cross-device channel)

JSON, under a **synced, non-dot** folder in the vault — confirmed: Obsidian Sync
**excludes every dot-folder except `.obsidian`**
([Sync docs](https://obsidian.md/help/sync/settings)), so a hidden `.og/` would
*not* replicate. Use `_OG/sync/` (non-dot); the plugin hides it from the file
explorer in-UI. Third-party sync (iCloud / Syncthing / Obsidian-Git) replicates
non-dot folders fine too, so the choice is sync-backend-agnostic. One file **per
client** → single-writer.

> **Why not `.obsidian/og/`?** `.obsidian` only syncs through Obsidian Sync's
> *category toggles* (which users often disable to keep per-device plugin config
> separate), and arbitrary `.obsidian/` subfolders aren't confirmed to sync at
> all. A non-dot folder syncs as ordinary content unconditionally, on every
> backend. The protocol channel must never sit behind a switch.

**Three settings buckets** (don't conflate them):

| Bucket | Where | Syncs? |
| --- | --- | --- |
| Protocol channel (bless / device files) | `_OG/sync/` (non-dot) | **Always** — the point |
| Synced *preferences* (ignores, author) | `data.json` via `saveData` | Yes, toggle-gated; non-critical if it fails |
| Device-local (`ClientId`, object store) | app-data / IndexedDB | **Never** |

```
<synced-data-dir>/
  device-<ClientId>.json   # this device's published state (presence + how far it has observed peers)
  bless-<ClientId>.json    # this device's latest bless record (overwritten in place = LWW)
```

> **Invariant (#5): a client only ever writes its own two files.** It reads every
> peer's files but never edits them. No write contention, no sync-conflict copies,
> no merge. **Primary deployment is Syncthing** (syncs everything incl.
> dot-folders, no toggles); single-writer-per-file is what stops Syncthing from
> ever producing `*.sync-conflict-*` copies of the signal files. The non-dot name
> is for portability, not necessity here.

### DeviceState file — presence / housekeeping (never correctness)

_(was `ClockFile`; it isn't a clock anymore — it's published device state.)_

```ts
interface DeviceState {
  client: ClientId;
  head: Seq;                       // this device's latest checkpoint seq
  baselineDigest?: Hash;           // optional digest of its baseline tree, for UI/divergence display
  /** Per-peer high-water-mark: the latest bless `seq` this device has *ingested*
   *  from each peer. Drives dedup + GC; bounds checkpoint retention. */
  observedSeq: Record<ClientId, Seq>;
  updatedAt: string;               // ISO; staleness/UI only, NOT correctness
}
```

### Bless file — the approval record

```ts
interface BlessRecord {
  client: ClientId;                // who blessed
  seq: Seq;                        // this client's bless sequence (monotonic)
  /** Delta from the blesser's baseline → the blessed checkpoint. Absolute
   *  hashes. The entire content payload a receiver needs. */
  manifest: Manifest;
  blessedAt: string;               // ISO; display + freshness/GC only
}
```

> A full-snapshot bless (re-anchor) is the same record with `manifest` covering
> _all_ non-ignored paths. Used occasionally to converge drifted baselines.

---

## Local state (per device, in the non-synced gitDir)

```ts
interface LocalState {
  self: ClientId;
  baseline: Hash;                  // commit ref `baseline`
  head: Seq;                       // own latest checkpoint seq
  observedSeq: Record<ClientId, Seq>;
  /** Bless records with entries not yet applicable (bytes not synced in). Retried
   *  each ingest; pruned by the freshness window. Persisted in the gitDir so a
   *  crash doesn't lose the obligation. */
  pending: BlessRecord[];
}
```

---

## Protocol — pseudo-code

### 1. Checkpoint (debounced batch + manual; #13)

```
checkpoint():                       # debounced on change, or user-invoked
  if engine.status().isEmpty: return    # noop if nothing changed (cheap to call repeatedly)
  git.commitAll(branch="checkpoints", message=`ckpt ${self}:${head+1}`)
  head += 1
  writeDeviceState({ self, head, baselineDigest, observedSeq, updatedAt: now })
```

No network. Grows the restore-point timeline + publishes `head`.

**Triggers:** the manual `Checkpoint` button always; plus an **optional
auto-checkpoint** (toggleable setting, configurable frequency, off by default) on
a debounce. Auto-checkpoint creates snapshots only — it **never** advances
`baseline` (no auto-bless). Retention (§7) prunes old auto-checkpoints.

### 2. Bless (approve current checkpoint on THIS device)

```
bless():
  delta = engine.diff(baseline → checkpoints@head)   # [(path, hash|DELETED)]
  rec   = { client: self, seq: ++blessSeq, manifest: delta, blessedAt: now }
  applyBless(rec)                  # advance our own baseline first (atomic, §4)
  writeBlessFile(rec)              # then publish (own file, LWW)
```

> Order matters for crash-safety: advancing our baseline is the atomic git ref
> move; publishing the file is derivable from `baseline`'s parent→baseline diff,
> so a crash between the two is recoverable (§ recovery).

### 3. Ingest (debounced sync settle; #4)

```
onSignalFilesChanged():            # debounce ~Ds so we don't process a half-synced batch
  fresh = []
  for peer bless file where rec.seq > observedSeq[rec.client]:
    fresh.push(rec); observedSeq[rec.client] = rec.seq
  for rec in (fresh ++ pending):
    if isStale(rec): drop(rec); continue        # §6
    applyBless(rec)                              # re-queues entries still gated
  writeDeviceState(...)                          # republish observedSeq / head
```

The debounce is an optimisation, not correctness: the content gate already defers
entries whose bytes haven't arrived. Debouncing just avoids churn on partial syncs.

### 4. applyBless — the core rule (per-file, content-gated, atomic)

```
applyBless(rec):
  newTree = treeOf(baseline)
  stillPending = false
  for entry in rec.manifest:
    target = entry.hash                          # Hash or DELETED

    # CONTENT GATE — the whole story. Simultaneously:
    #   • arrival gate (bytes/delete haven't synced yet),
    #   • causal cut (a newer local edit won't match an older blessed hash),
    #   • conflict resolver (only the bless matching current content admits).
    matches = (target == DELETED)
                ? !exists(workingTree[entry.path])
                : hashOf(workingTree[entry.path]) == target
    if not matches:
      stillPending = true                        # retry next ingest (or prune if stale)
      continue

    if target == DELETED: newTree.remove(entry.path)
    else:                 newTree.set(entry.path, blobFromWorkingTree(entry.path))

  if newTree != treeOf(baseline):
    commit = git.commit(tree=newTree, parent=baseline)
    git.updateRef("baseline", commit)            # ATOMIC — the single commit point
    baseline = commit
  if stillPending: keep rec in `pending` else drop it
  refreshUI()
```

### Revert / rollback (#7, #9)

```
revertPath(P):                     # restore one file to baseline
  workingTree[P] := bytesOf(baseline, P)         # now P == baseline ⇒ pending clears, no bless
                                                  # syncs out as a normal edit

rollbackTo(checkpointX):           # user-initiated via OUR UI ⇒ intentional ⇒ auto-bless
  workingTree := contentOf(checkpointX)
  bless()                                          # advances baseline to X; emits bless record
                                                    # unblessed checkpoints stay retained ⇒ undoable
```

> A rollback performed by **some other tool** is indistinguishable from edits, so
> it lands as normal pending changes — correct, since we can't attribute intent.

### Crash recovery (#6)

```
onStartup():
  # 1. git is self-consistent: baseline is either the old or new commit (atomic ref).
  # 2. Re-ingest EVERY current bless file (including our own), unconditionally.
  #    applyBless is idempotent ⇒ converges regardless of where a crash landed:
  #      - crashed after ref move, before observedSeq write → re-apply is a noop
  #      - crashed after observedSeq write, before ref move  → re-apply advances
  #      - crashed mid-manifest                              → matched paths already
  #        committed atomically into the (possibly earlier) baseline; unmatched retry
  for rec in allCurrentBlessFiles(): applyBless(rec)
  # 3. Republish our own bless file from baseline's parent→baseline diff if missing/stale.
```

Atomic ref move + idempotent full re-ingest = no partial-bless corruption.

---

## 5. Convergence (the "CRDT shape")

Each device's baseline is a map `Path → (Hash | absent)` realised as a git tree.
The only mutation is "set `path = h` **iff** `workingTree[path]` hashes to `h`."
For a fixed working tree and a fixed observed bless set this fold is:

- **idempotent** — re-applying a matching entry rewrites the same blob;
- **commutative** — at most one competing hash per path can match the current
  working tree, so apply order is irrelevant;
- **convergent** — two devices with the same working tree + same observed blesses
  derive the same baseline tree.

A content-keyed last-writer-wins register where the winner is decided by sync (the
working tree), not by us — hence no clock, no CRDT runtime.

---

## 6. Freshness / staleness (ABA guard + GC; #12)

```
isStale(rec):
  return rec.seq <  observedSeq[rec.client]       # superseded by a newer bless from same client (always safe)
      or now - rec.blessedAt > FRESHNESS_WINDOW   # ABA guard (see default)
```

**Suggested default: `FRESHNESS_WINDOW = 30 days`.** Reasoning: the time clause's
*only* job is the rare ABA case (content cycling back to long-ago-blessed bytes);
dropping a **legitimately delayed** bless (a device offline for a while) is the
worse failure, so the window must exceed any realistic offline+sync-settle gap.
30 days clears that comfortably while still letting truly-dead one-off records
expire for GC. The `seq < observedSeq` clause handles ordinary dedup
independently of time and is always safe. Tunable; could even be ∞ (trust
content-addressed approval entirely).

---

## 7. Retention / GC (#8, #9)

- **Signal files** are per-client, overwritten in place → bounded, no rotation.
- **Blessed-state history** = `baseline`'s first-parent chain. **Keep the last N
  blessed checkpoints** (#8) for change history + rollback to a prior _approved_
  state. Default N e.g. 50 (tunable).
- **Unblessed restore points** = `checkpoints` commits since their last bless.
  **Keep for a time window** (#9) so a rollback can itself be undone (jump back to
  a still-retained unblessed checkpoint, which then gets blessed). Default e.g.
  7 days / last K (tunable).
- Pruning never breaks correctness: bless manifests carry **self-contained**
  absolute hashes, so a pruned checkpoint only costs the ability to _render_ that
  historical diff, never the ability to apply a bless.
- `pending` records pruned by the freshness window (§6).

---

## 8. Boundary cases (content is the ground truth)

1. **New device, no history — or a device whose local store was evicted** (iOS
   can reclaim IndexedDB under storage pressure) → treat the synced working tree
   as candidate and **rebuild baseline from the synced bless records**
   (content-addressed + self-contained). Only *unblessed local checkpoint history*
   is lost; the trust marker fully reconstructs. So losing the device-local store
   is graceful re-bootstrap, never data loss. (A regenerated `ClientId` just means
   the device is treated as new; its old `bless-<oldid>.json` lingers until GC.)
2. **Stuck-pending** (changed-for-me but never-changed-for-the-blesser, so absent
   from their delta) → I bless my own pending set; or a periodic **full-snapshot
   bless** re-anchors everyone.
3. **Pruned checkpoint referenced by a bless** → manifest hashes self-contained ⇒
   still applies; only historical diff rendering is lost.
4. **Partial sync at bless time** → nothing over-claimed; receivers gate on content.
5. **ABA / stale bless** → freshness window (§6).
6. **Crash mid-apply** → §recovery.

---

## Open questions to resolve before building

- [x] ~~Vector clock vs per-path stamp~~ → **neither**; content gate suffices.
- [x] ~~Mobile fork~~ → **full participant** on mobile (#10). `obsidian-git`
  resolves the hard unknowns: isomorphic-git *does* run on Obsidian iOS/Android,
  the `Buffer` gap is a known 6-line bundler `inject` polyfill, and a custom
  `fs.promises` shim is the bridge. We run **isomorphic-git over IndexedDB**
  (non-synced; adapter-files would leak to iCloud/Syncthing and collide
  per-device refs); eviction → re-bootstrap.
- [x] **Mobile spike (Node-level ✅; on-device still pending):** isomorphic-git +
  LightningFS (IndexedDB `fs.promises`) round-trips blob/tree/commit driven by the
  real `ReviewEngine` through `createRoutingFs` (gitdir→LightningFS,
  worktree→node:fs), verified with `fake-indexeddb` in
  `packages/engine/test/indexeddb-store.spike.test.ts` (onboard→bless + byte
  round-trip via revert). Surfaced + fixed two node:fs-isms the engine relied on
  (`mkdir {recursive}`, `replica-id` static fs). **Still to verify on real
  hardware:** the Buffer polyfill in the WKWebView and live IndexedDB on Android
  (fake-indexeddb is not the real engine). Fallback if on-device fails: the
  ~100-line Merkle KV over IndexedDB. The Merkle-KV fallback now looks unlikely
  given the Node round-trip works unmodified.
- [ ] **Incremental hashing is mandatory on mobile, not an optimisation.**
  obsidian-git reports a full ~3000-file status at **~3m40s on an iPad Pro M1**.
  Drive diffing from `vault.on(modify/create/delete/rename)` events (re-hash only
  touched paths) + an mtime/size stat-cache — never a full-vault rescan per
  debounce. (Parked engine follow-up; mobile makes it a requirement.)
- [ ] **Mobile build: Buffer polyfill.** isomorphic-git needs `Buffer`, absent in
  the mobile WKWebView. obsidian-git uses a conditional
  `require('buffer/index.js').Buffer` injected via esbuild. Reproduce with
  **tsdown**'s inject/banner equivalent for `packages/plugin`; keep `buffer`
  bundled (not external).
- [x] ~~Device id persistence~~ → store `ClientId` in the device-local object
  store, **not** `localStorage` (evicted on iOS). Loss → new id, re-bootstrap as a
  new device (acceptable). The obsidian-git `localStorageSettings` split is the
  community pattern but is unreliable on iOS for must-persist state.
- [x] ~~Tombstone shape~~ → explicit `DELETED` sentinel (#1).
- [x] ~~JSON vs front-matter~~ → **JSON** (#11).
- [x] ~~Trust model~~ → **single-user assumed** (#14).
- [x] ~~Synced-data-dir location~~ → **`_OG/sync/` (non-dot), plugin-hidden.**
  Obsidian Sync docs confirm dot-folders (except `.obsidian`) are excluded from
  sync, so a hidden `.og/` wouldn't replicate. The gitDir never goes in the vault
  at all (would leak to iCloud/Syncthing), so this signal folder is the *only*
  in-vault footprint — and it's meant to sync.
- [ ] **Retention defaults** — N blessed (≈50?), unblessed window (≈7d?),
  `FRESHNESS_WINDOW` (30d) — tune with real usage.
- [ ] **Engine deltas from today** — (a) replace direct `node:fs` use with the
  injected `WorkingTree` + `ObjectStore` interfaces (§Storage model); (b)
  `baseline` becomes a commit advanced via new-tree commit; (c) add `checkpoints`
  ref + retention; (d) per-path baseline overlay in `applyBless`; (e) `DELETED`
  in the diff/manifest; (f) plugin (mobile) `ObjectStore` over LightningFS.
  Reuse: content hashing, blob read, ignore matcher.

## Lineage (superseded plans)

This design absorbed three earlier (now-removed) plans:

- A **file-controlled bless** plan — its monotonic-seq + high-water-mark survive
  here as `observedSeq`.
- A **checkpoints-and-undo** plan — its checkpoint primitive is consumed and
  extended (checkpoint = local commit; baseline = a separate advanceable commit
  ref; retained unblessed checkpoints = undo).
- A **multi-vault-watcher** plan — made irrelevant by dropping the server (a
  server, if ever reintroduced, is just another symmetric client).
