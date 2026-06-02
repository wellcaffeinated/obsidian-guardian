# Obsidian Guardian — p2p-bless rewrite

> **Review what changed in your vault since the last _blessed_ state, and roll
> back — entirely inside Obsidian, on every device.** No server, no designated
> "git manager." Each device tracks changes in its own local (never-synced) git;
> devices coordinate the _trust marker_ ("blessed up to here") through small
> synced JSON files. Mobile is a first-class participant, not a viewer.

This branch (`plan/p2p-bless-protocol`, worktree `.worktrees/p2p-bless`) is a
**ground-up redesign** away from the old client/server (container watcher +
view-only mobile) model. Feel free to gut old code; the **engine** is the only
durable asset and it gets refactored, not discarded.

## Canonical design

**[`plans/p2p-bless-protocol.md`](plans/p2p-bless-protocol.md) is the source of
truth** for the protocol (data shapes, the content-gated apply rule, storage
model, retention, mobile). Read it first. This file tracks _how we build_.

### The model in five sentences

1. **Checkpoint** = a content snapshot (local git commit) with a per-device
   monotonic seq, made on a debounced batch or manually.
2. **Baseline** = a commit ref = "last blessed state"; **pending** = diff
   baseline→working-tree (content-hashed).
3. **Bless** = approve a checkpoint, published as a synced delta manifest of
   absolute content hashes (`bless-<deviceId>.json`).
4. Each device **applies** a received bless _per file_, advancing its baseline
   only where its own synced working tree already hashes to the blessed value —
   that single **content gate** is the whole conflict story (no vector clocks,
   no CRDT lib).
5. **Rollback** to a checkpoint is an intentional, auto-blessed move; unblessed
   checkpoints are retained for a window so a rollback can be undone.

### Environment assumptions (this user)

- **Sync = Syncthing** (not Obsidian Sync). Syncs everything on disk incl.
  dot-folders; no toggles. ⇒ signal folder syncs regardless of name; the git
  store **must** live outside the vault or Syncthing corrupts it across devices.
- **Targets: desktop (Linux) + Android.** iOS is best-effort/low-priority
  (untested; the fragile WKWebView case).
- **Self-install, no community store:** copy `dist/` into
  `<vault>/.obsidian/plugins/obsidian-guardian/`; Syncthing propagates it.

## Architecture: one engine, injected storage

`ReviewEngine` stays a **pure TS module, zero `obsidian` imports**, but its
storage is **dependency-injected** so it runs on desktop and mobile:

- **`WorkingTree`** — list/read/write vault files. Impl: `node:fs` (CLI/desktop)
  or `app.vault.adapter` (plugin; works on Android).
- **`ObjectStore`** — content-addressed blob/tree/commit/ref db, **device-local,
  never synced**. Impl: isomorphic-git over `node:fs` (desktop), isomorphic-git
  over IndexedDB (mobile — Buffer polyfill needed; `obsidian-git` proves the
  approach), with a ~100-line Merkle KV as a fallback.

Only the content **Hash** (git blob sha) must agree across devices; each store
is private, so on-disk format need not. **Never `import … from 'obsidian'` in
`packages/engine`.**

## Repo layout

```
packages/
  engine/   pure ReviewEngine (refactor: inject WorkingTree+ObjectStore,
            baseline-as-commit-ref, checkpoints, content-gated diff, coordination)
  plugin/   THE product — Obsidian plugin (desktop + Android); the GUI panel
  cli/      legacy (old container watcher). Kept for now as a headless test
            harness / future "always-on desktop peer"; not the deliverable.
```

## Commands

- `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format` ·
  `pnpm knip` (root = all packages; per-pkg via
  `pnpm --filter @obsidian-guardian/<pkg> <script>`).
- `pnpm screenshot:plugin [out.png]` — build + load the plugin in headless
  Obsidian and capture the panel (default `screenshots/plugin-<ts>.png`); leaves
  the container running for fast re-shots. **Needs docker.**
- `pnpm test:plugin` — full plugin smoke in the headless container.

## Conventions

- **pnpm** (not npm/yarn/bun). **tsdown** bundler · **Vitest** · **Biome**
  lint/format · **Knip** dead-code. Helper skills under `.claude/skills`
  (`tsdown`, `vitest`, `knip`, …) — use them.
- **Named exports only**; re-export from each package's `src/index.ts`.
- **Conventional Commits** (feat/fix/chore/…).

## Testing the plugin (hard-won gotchas — still apply)

- **Only ever test in the headless container, never the user's real Obsidian.**
  Drive via `docker compose -f docker-compose.plugin-test.yaml exec -T obsidian
  obsidian <cmd>` (see `scripts/lib.sh`). Plugin id is `obsidian-guardian`.
- Container starts in **Restricted Mode**: enable via the
  `enable-plugin-<appId>` localStorage flag + `loadManifests()` +
  `enablePlugin(id)`, and **retry** (the plugins API lags `obs version` readiness).
- Roastery specifics: docker + `pnpm install` need `dangerouslyDisableSandbox`.

## Phased plan (not exhaustive up-front; update at each milestone)

- [x] **Phase G — GUI stub first.** A plugin detached from functionality
  (`packages/plugin/src/{main,review-view}.ts` + `styles.css`) rendering the
  panel from **mock data**: time-ordered timeline (Current card → HISTORY →
  checkpoints + baseline marker), per-file diff + revert, Accept/Undo inside the
  current card, `a..b` comparison labels. Iterated with the user to v4.
  Screenshot via **`pnpm shot:stub`** (overlay workaround for Obsidian deferred
  views — see memory). Settles the data the engine must expose.
- [~] **Phase 1 — Engine storage refactor.** _← we are here._
  - [x] **Inject `fs`** — `EngineConfig.fs: PromiseFsClient`; `git-ops.ts` +
        `engine.ts` carry no static `node:fs` (sync ops → async). Desktop/CLI
        inject `node:fs`; plugin injects a shim later. Green: 61 tests,
        typecheck, build, lint, knip. (Interim: `replica-id.ts`/`state.ts` still
        import `node:fs/promises` — they're old-signal-file machinery removed in
        Phase 2; `node:path` swap is a small follow-up.)
  - [ ] **Composite routing `fs`** — one `PromiseFsClient` routing
        worktree-paths vs gitdir-paths to two backends (both `node:fs` on
        desktop; worktree→adapter / gitdir→IndexedDB on mobile). See plan
        §Storage model.
  - [ ] **Model shifts** (likely fold into Phase 2): baseline advanced per-path;
        trim old machinery (`snapshot`/`writeSnapshot`/`changes-file`/
        `replica-id`/`state`/review-note).
- [~] **Phase 2 — Coordination layer.** _Core built (engine-only)._
  - [x] **Coordination types** (`types.ts`): `ClientId`/`Hash`/`Seq`/`Path`,
        `DELETED` sentinel, `ManifestEntry`/`Manifest`, `DeviceState`,
        `BlessRecord`, `LocalState`, `ApplyResult`.
  - [x] **Tree overlay primitives** (`git-ops.ts`): `readFlatTree`/`writeFlatTree`
        (recursive nested-tree build), `writeBlob`/`hashBlob` — so the baseline
        advances **per path** (old baseline tree ⊕ admitted blobs, atomic ref move).
  - [x] **`applyBless` content gate** (`engine.ts`): per-file LWW register, no
        vector clock. Simultaneously arrival gate / causal cut / conflict
        resolver. `bless()` now emits a delta `BlessRecord` (absolute hashes +
        tombstones), advances our own baseline, publishes the signal files.
  - [x] **Synced signal store** (`signal-store.ts`): `_OG/sync/` JSON
        (`device-<id>.json` + `bless-<id>.json`, single-writer LWW); read peers.
  - [x] **`ingest()`** (debounced sync-settle): fold fresh+pending peer blesses
        through the gate, seq-dedup + `FRESHNESS_WINDOW_MS` (30d), retain gated,
        republish `DeviceState`. **`recover()`**: idempotent re-apply of all
        blesses for crash / re-bootstrap (lost device store).
  - [x] **`LocalState` persistence** (`local-state.ts`): `observedSeq`,
        `blessSeq`, `pending` in the non-synced gitDir.
  - Green: **49 engine tests** (incl. 13 new coordination: gate idempotent /
    commutative / causal-cut / arrival-defer / tombstone / converge / e2e ingest
    / recover), typecheck, knip, build. Full workspace 74 tests still green.
  - [ ] **Retention/GC** (deferred — spec says pruning never breaks correctness):
        keep last-N blessed (baseline first-parent chain) + unblessed-checkpoint
        window; `pending` already pruned by freshness.
  - [ ] **Crash republish gap:** `recover()` re-applies blesses but does not yet
        re-derive + republish *our own* `bless-<id>.json` from baseline's
        parent→baseline diff if it went missing (spec §recovery step 3).
- [ ] **Phase 3 — Plugin integration.** Wire engine + coordination into the
  Phase-G panel (real data); per-device activation; event-driven **incremental**
  hashing (mandatory — full rescans are too slow on mobile); settings.
- [ ] **Phase 4 — Mobile (Android).** IndexedDB `ObjectStore`; Buffer polyfill
  via tsdown inject; the spike (isomorphic-git + IndexedDB round-trip); drop
  `isDesktopOnly`; sideload + Syncthing round-trip across the user's devices.
- [ ] **Phase 5 — Polish.** Inline diffs, peer/sync UX, packaging (later;
  community store is low priority).

### Resume here (session handoff)

**State:** branch `plan/p2p-bless-protocol`, worktree `.worktrees/p2p-bless`
(install deps there: `pnpm install`). Phase G ✅ + Phase-1 `fs`-injection ✅ +
**Phase-2 coordination core ✅** (engine-only). All gates green: `pnpm -r test`
= **74** (49 engine / 9 cli / 16 plugin), `pnpm -r typecheck`, `pnpm knip`,
engine `pnpm build`. Coordination commits on top of `98bee51`.

**Next step — choose:**
1. _Recommended:_ **Phase 3 — plugin integration.** Wire the real engine
   coordination API into the Phase-G panel: per-device activation (gitDir
   existence = activation flag), `vault.on(modify/create/delete/rename)` →
   **incremental** re-hash (full rescans too slow on mobile) → debounced
   `checkpoint()`/`refresh`, a watcher on `_OG/sync/` → debounced `ingest()`,
   `recover()` on layout-ready, and Bless/Rollback buttons calling
   `engine.bless()` / revert. New engine API to consume: `bless()→BlessRecord`,
   `applyBless`, `ingest`, `recover` (`packages/engine/src/index.ts`).
2. Or **trim old machinery** now that the new path exists: `review-note.ts`,
   `changes-file.ts`, the engine's `snapshot`/`writeSnapshot`/`blessSnapshot`,
   the rotating-file bits of `replica-id.ts`, and `state.ts`'s
   `bless-hwm`/`snapshot-seq`. **Caution:** the CLI (`watch.ts`/`cli.ts`) +
   plugin still call these; rip them out only with replacements wired, or those
   green packages break. Lower urgency — the old machinery is inert, just unused
   by the new flow.
3. Or finish **retention/GC** + the **crash-republish** gap (both noted under
   Phase 2 above).

**Working references:** coordination core = `packages/engine/src/{engine,
git-ops,signal-store,local-state,types,defaults}.ts`; tests =
`packages/engine/test/coordination.test.ts` (the convergence + ingest proofs).
GUI stub = `packages/plugin/src/{main,review-view}.ts` + `styles.css` (mock
data, v4); screenshot with **`pnpm shot:stub [out.png]`** (overlay workaround —
see memory `headless-screenshot-deferred-view`). CLI (`packages/cli`) is legacy.

**Watch-outs:**
- The signal folder is `_OG/sync/`; `_OG/` is git-ignored, so signals **sync
  but never commit** into the device-local store — keep it that way.
- Two notions of "pending" differ: `status().clean` is working-tree-vs-baseline;
  a bless *obligation* (`stillPending`) lives in `LocalState.pending`. A gated
  bless can leave status clean while the obligation persists (see the
  arrival-gate test).
- Engine still pulls `node:fs` transitively via `replica-id.ts`/`state.ts`
  (`node:fs/promises`) — not yet 100% mobile-clean; `local-state.ts`/
  `signal-store.ts` correctly use the injected `fs`. `node:path` swap pending.
- Test the plugin only in the headless container, never the real vault.

## Locked decisions

- Symmetric, **server-less**: every device runs the engine over its own
  never-synced git; the only cross-device channel is synced JSON signal files.
- **Coordinate the marker, not git state.** Bless = content-hash delta manifest;
  apply is per-file content-gated ⇒ idempotent/commutative ⇒ no vector clock, no
  CRDT library. Working tree (post-sync) is the conflict arbiter.
- **Baseline = a commit ref**; advancing = new tree (old baseline ⊕ blessed
  paths) + atomic ref move. Lean on git (isomorphic-git) for storage everywhere.
- **One file per device** in `_OG/sync/` (single-writer) ⇒ no Syncthing
  conflict files.
- **gitDir/ObjectStore never inside the vault** (Syncthing would corrupt it):
  app-data on desktop, IndexedDB on mobile. Device-local store loss ⇒ graceful
  **re-bootstrap** from synced blesses, never data loss of the trust marker.
- **Reviewing is opt-in per device** (the local store's existence is the
  non-synced activation flag); installing the plugin doesn't auto-start a
  competing history.
- **Auto-checkpointing is a toggleable setting** (off by default) with a
  **configurable frequency**; the manual `Checkpoint` button is always
  available. Auto-checkpoint creates snapshots only — it never advances the
  `baseline` (no auto-bless). Retention prunes old auto-checkpoints.
