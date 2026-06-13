# Build history — the p2p-bless rewrite

> **Historical reference, not a spec.** This is the phased build log of how the
> current plugin was constructed during the `plan/p2p-bless-protocol` rewrite —
> kept for archaeology (why a thing is the way it is). The _intent_ source of
> truth is [`p2p-bless-protocol.md`](p2p-bless-protocol.md); outstanding work is
> in [`future-plugin-work.md`](future-plugin-work.md); current orientation is in
> the repo root `CLAUDE.md` and `README.md`.

## The pivot

The project began as a **client/server** design: a Docker container / CLI ran a
long-lived watcher that owned the canonical git history and wrote a synced,
human-readable "changes note"; other devices (notably mobile) were **view-only**
readers of that note. Phases 0–2 of that era (pure engine core, CLI + container
adapter, a first desktop-plugin slice) were built and shipped green.

The rewrite replaced it with a **symmetric, server-less** model: every device
runs the engine over its own device-local (never-synced) git and devices
coordinate only the _trust marker_ through small synced JSON signal files. The
engine survived the pivot (refactored, not discarded); the CLI/container and the
synced changes-note were eventually deleted. The phases below are the rewrite.

## Phase G — GUI stub first

A plugin detached from functionality (`packages/plugin/src/{main,review-view}.ts`
+ `styles.css`) rendering the panel from **mock data**: a time-ordered timeline
(Current card → HISTORY → checkpoints + baseline marker), per-file diff + revert,
Accept/Undo inside the current card, `a..b` comparison labels. Iterated with the
user to v4 (`screenshots/gui-stub-v4.png`). Screenshot via `pnpm shot:stub` (an
overlay workaround for Obsidian deferred views). Purpose: settle the data shape
the engine had to expose before building it.

## Phase 1 — Engine storage refactor

- **Inject `fs`** — `EngineConfig.fs: PromiseFsClient`; `git-ops.ts` + `engine.ts`
  carry no static `node:fs` (sync ops → async). Desktop injects `node:fs`; the
  plugin injects platform shims.
- **Composite routing `fs`** (`routing-fs.ts`, `createRoutingFs`) — one
  `PromiseFsClient` that dispatches each call by path: paths under `gitDir` → the
  device-local object-store backend, everything else → the working tree. Paths
  pass through verbatim; `symlink` routes by its 2nd arg (the link location). On
  desktop both backends are `node:fs`; on mobile they become
  worktree→`app.vault.adapter` / gitdir→IndexedDB with no engine change.

## Phase 2 — Coordination layer (the heart of the rewrite)

- **Coordination types** (`types.ts`): `ClientId`/`Hash`/`Seq`/`Path`, a
  `DELETED` tombstone sentinel, `ManifestEntry`/`Manifest`, `DeviceState`,
  `BlessRecord`, `LocalState`, `ApplyResult`.
- **Tree overlay primitives** (`git-ops.ts`): `readFlatTree`/`writeFlatTree`
  (recursive nested-tree build), `writeBlob`/`hashBlob` — so the baseline advances
  **per path** (old baseline tree ⊕ admitted blobs, atomic ref move).
- **`applyBless` content gate** (`engine.ts`): a per-file last-writer-wins
  register, no vector clock. It is simultaneously the arrival gate, the causal
  cut, and the conflict resolver. `bless()` emits a delta `BlessRecord` (absolute
  hashes + tombstones), advances our own baseline, and publishes the signal files.
- **Synced signal store** (`signal-store.ts`): `_OG/sync/` JSON
  (`device-<id>.json` + `bless-<id>.json`, single-writer LWW); reads peers.
- **`ingest()`** (debounced sync-settle): folds fresh + pending peer blesses
  through the gate, seq-dedups within a `FRESHNESS_WINDOW_MS` (30d), retains gated
  obligations, republishes `DeviceState`. **`recover()`**: idempotent re-apply of
  all blesses for crash / re-bootstrap after a lost device store.
- **`LocalState` persistence** (`local-state.ts`): `observedSeq`, `blessSeq`,
  `pending` in the non-synced gitDir.

## Phase 3 — Plugin integration (the Phase-G panel, on real data)

- **Engine timeline API.** `timeline()` → `{ baseline, current, checkpoints[] }`
  (each checkpoint carries its diff to the working tree); `listCheckpoints()`
  (reads `refs/og/checkpoints/*`); `restoreCheckpoint(oid)` (rollback to an
  arbitrary snapshot, baseline untouched). `walkChanges`/`readMarkerBlob`/
  `buildChanges`/`restore` generalised to an arbitrary `fromRef` (default =
  baseline).
- **Plugin wiring** (`main.ts`): resolves config + injects fs, a per-device
  **activation gate** (`isOnboarded()` — never onboards on load), `recover()` on
  layout-ready, debounced **refresh** on `vault.on(modify/create/delete/rename)`,
  a `_OG/sync/` watcher → debounced **`ingest()`**, first-activation auto-bless
  (settles host config writes), commands, ribbon, settings tab. Implements
  `ReviewController` + `SettingsHost`.
- **Real panel** (`review-view.ts`): driven by a `ReviewController` interface (no
  plugin import / no cycle); inactive CTA, the Current card (Accept=bless /
  Undo=rollback / per-file revert / clickable md paths), collapsible checkpoint
  History + Baseline marker, peer-presence header. View-model built by pure
  `buildPanelData()` in `format.ts` (the DOM-free test seam).
- **Clickable status bar** (`OG: inactive` / `OG: clean` / `OG: N pending`).
- **Event-driven incremental hashing.** The engine keeps a `workIndex`
  (`path → blob oid`); `touch(path)` re-hashes one path, `rescan()` does an
  authoritative full reconcile. `buildChanges` uses the index when primed (diffing
  it against any base tree — baseline OR a checkpoint — reading only changed files
  for stats), else falls back to a full walk so non-live callers stay accurate.
  `bless()` invalidates the index. The plugin queues edited paths from
  `vault.on(...)` and `touch`es them in the debounced flush; Refresh calls
  `rescan()`.
- **Confirm-modal gate** (`ConfirmModal`): the two destructive actions —
  rollback and restore-checkpoint — require Cancel/Confirm before discarding
  unblessed work. Per-file revert stays ungated (native file history covers it).
- **Inline per-file diffs + colored stats.** Engine `fileDiff(path, fromRef?)`
  (+ `lineDiff` in `diff-stats.ts`) computes a signed line list base→workdir,
  lazily on expand. The panel renders `+N`/`−N` stats and expandable colored hunks;
  the filename stays a click-to-open link.

## Phase 4 — Mobile (Android) load-safety

The core unknown — can the engine run with its git store in a browser? — was
de-risked in Node first, then made real:

- **IndexedDB object-store spike** (`test/indexeddb-store.spike.test.ts`): the
  engine runs end-to-end with its **gitdir on IndexedDB** (LightningFS +
  `fake-indexeddb`) and the worktree on `node:fs`, composed by `createRoutingFs` —
  the exact mobile split. Surfaced two portability bugs, now fixed: `mkdir({recursive})`
  is a node-ism LightningFS ignores (→ `fs-utils.ts` `ensureDir` mkdirp); and a
  static `node:fs/promises` import in `replica-id.ts` (→ injected fs).
- **Buffer polyfill** — isomorphic-git needs a `Buffer` global absent in the
  mobile WKWebView. tsdown **aliases `buffer` → feross `buffer/index.js`** so
  `safe-buffer`'s `require('buffer')` bundles the polyfill; and `main.ts` does
  `globalThis.Buffer ??= <feross>` for iso-git's free `Buffer` global. No-op on
  desktop's native Buffer.
- **Real mobile backends behind the router + `isDesktopOnly: false`.** `resolveEnv`
  (`main.ts`) builds per platform: **mobile** = worktree on the vault adapter
  (`adapter-fs.ts`) + gitdir on live IndexedDB (`LightningFS`); **desktop** =
  `node:fs` for both. The load-safety work was getting the bundle to load with
  **no Node builtin `require` at module-load** on mobile:
  - `node:fs`/`node:os` confined to `desktop-env.ts`, pulled via a runtime
    `require` *inside functions* (only the desktop branch calls them).
  - `config.ts` made mobile-safe (dropped `node:crypto`/`node:os`).
  - tsdown aliases: `node:path`/`path` → `pathe`; `isomorphic-git` → its **ESM
    build** (the `node` condition's CJS does `require('crypto'/'fs')` at module top
    — fatal on mobile; the ESM build uses Web Crypto + injected fs).
- **node:fs / node:crypto leaks closed.** `state.ts` seq/HWM helpers take the
  injected fs; `replica-id.ts` no longer imports `node:crypto`. New
  `crypto-utils.ts`: `randomId()` + a sync, dependency-free `sha256Hex()` proven
  byte-identical to `node:crypto`. The engine `src/` is now free of every node
  builtin except `node:path` (pure string ops, fine in WKWebView).

  **On-device Android remained unverified** at this point (no mobile runtime in
  the build environment) — see `future-plugin-work.md`.

## CLI + old-machinery removal (rewrite close-out)

Once the plugin was the product, the legacy surface was deleted: `packages/cli/`
entirely; the container artifacts (`Dockerfile`, compose, entrypoint, demo vault);
the CLI smoke scripts; and the dead engine machinery from the client/server era —
`review-note.ts`, `changes-file.ts`, the `SnapshotStatus` type, engine
`refresh()`/`snapshot()`/`writeSnapshot()`/`blessSnapshot()`, the old
`reviewNoteName`/`changesFile*` helpers in `replica-id.ts`, and the `bless-hwm`
helpers in `state.ts`. The repo collapsed to two packages: `engine` + `plugin`.
Gate state at close-out: 91 tests (57 engine / 34 plugin), typecheck / lint
(1 pre-existing CSS warning) / knip / builds / live `pnpm test:plugin` all green.
