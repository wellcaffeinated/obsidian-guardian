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
- **Never shadow a base-class member when extending an `obsidian` class.** When
  you `extends ItemView` / `View` / `Plugin` / `Modal` / `Component` / etc., your
  instance **fields and methods share one namespace with the base class's own
  fields/methods** — and Obsidian's runtime classes have many *undocumented*
  members not in `obsidian.d.ts`. A collision is silent and brutal: e.g. a
  `ReviewView` field named `open` made Obsidian construct the view but **never
  call `onOpen()`** (blank panel, no error). Defend against it:
  - Give view/plugin state **specific, namespaced field names** (`openCheckpoints`,
    not `open`; `diffCache`, not `cache`). Avoid bare generic names — `open`,
    `view`, `app`, `leaf`, `icon`, `scope`, `navigation`, `containerEl`,
    `contentEl`, `state`, `load`, `update`, `setState`/`getState`,
    `register*`, `on*` — on any subclass of an `obsidian` class.
  - Only **intentionally** override base methods (`onOpen`, `onClose`, `onload`,
    `onunload`, `getViewType`, `getDisplayText`, `getIcon`, `setState`); mark them
    `override` so the compiler tells you when a name unexpectedly *does* match the
    base (and conversely flags a typo'd override that silently doesn't).

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
  - [x] **Composite routing `fs`** (`routing-fs.ts`, `createRoutingFs`) — one
        `PromiseFsClient` that dispatches each call by path: paths under `gitDir`
        → the device-local object-store backend, everything else → the working
        tree. Paths pass through verbatim (each backend interprets the absolute
        path, as today on desktop); `symlink` routes by its 2nd arg (the link
        location). On desktop both backends are `node:fs`; on mobile they become
        worktree→`app.vault.adapter` / gitdir→IndexedDB without touching the
        engine. Exported from `index.ts`. 2 tests (`test/routing-fs.test.ts`):
        spy-wrapped backends prove the routing contract (every gitdir path hits
        the gitdir backend, every vault path the worktree backend) + full
        onboard→bless parity through the router. NOT yet wired into the plugin
        (desktop still injects `node:fs` directly); the plugin swap is Phase 4,
        when the real mobile backends exist. See plan §Storage model.
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
- [x] **Phase 3 — Plugin integration.** _✅ green + live._ The
  Phase-G panel now renders **real engine data** end-to-end; the live smoke
  (`pnpm test:plugin`) passes on the new design (inactive→activate→bless flow,
  asserted via the synced `_OG/sync/` signal files), and the populated panel is
  verified by an overlay screenshot.
  - [x] **Engine timeline API.** `timeline()` → `{ baseline, current,
        checkpoints[] }` (each checkpoint carries its diff to the working tree);
        `listCheckpoints()` (reads `refs/og/checkpoints/*`); `restoreCheckpoint(oid)`
        (rollback to an arbitrary snapshot, baseline untouched). `walkChanges`/
        `readMarkerBlob`/`buildChanges`/`restore` generalised to an arbitrary
        `fromRef` (default = baseline). Types `Checkpoint`/`Timeline`/
        `TimelineEntry` exported. 4 new engine tests (`test/timeline.test.ts`).
  - [x] **Plugin wiring** (`main.ts`): resolves config + injects `node:fs`,
        per-device **activation gate** (`isOnboarded()` — never onboards on
        load), `recover()` on layout-ready, debounced **refresh** on
        `vault.on(modify/create/delete/rename)`, a `_OG/sync/` watcher →
        debounced **`ingest()`**, first-activation auto-bless (settle host
        config writes), commands (open/activate/refresh/checkpoint/bless/rollback),
        ribbon, settings tab. Implements `ReviewController` + `SettingsHost`.
  - [x] **Real panel** (`review-view.ts`): driven by a `ReviewController`
        interface (no plugin import / no cycle); renders inactive CTA, the
        Current card (Accept=bless / Undo=rollback / per-file revert / clickable
        md paths), collapsible checkpoint History + Baseline marker, peer
        presence header. View-model built by pure `buildPanelData()` in
        `format.ts` (DOM-free test seam; 3 new plugin tests).
  - [x] **Settings tab** (`settings.ts`): gitDir / reviewFolder / marker /
        ignore / author; `hide()` persists + rebuilds the engine.
  - [x] **Clickable status bar** (`OG: inactive` / `OG: clean` / `OG: N
        pending`, opens the panel) — restored from the pre-rewrite plugin; it
        had been dropped in the redesign. Plus a dead-code sweep: removed
        `describeStatus`/`ChangeRow`/`describeChange` (the superseded first-slice
        view-model, only referenced by its own tests).
  - [x] **Event-driven incremental hashing.** The engine keeps a `workIndex`
        (`path → blob oid`); `touch(path)` re-hashes one path, `rescan()` does an
        authoritative full reconcile. `buildChanges` uses the index when primed
        (diffing it against any base tree — baseline OR a checkpoint — with no
        full-tree reads; only changed files are read for stats), else falls back
        to the full walk, so non-live callers (tests/CLI) stay disk-accurate.
        `bless()` invalidates the index (re-primes from disk; the manifest is
        always built from the authoritative full walk). The plugin queues edited
        paths from `vault.on(...)` and `touch`es them in the debounced flush;
        the explicit Refresh button calls `rescan()`. +5 engine tests.
  - [x] **Confirm-modal gate** (`ConfirmModal` in `review-view.ts`): the two
        destructive actions — rollback ("Undo these changes") and
        restore-checkpoint — now require a Cancel/Confirm dialog before
        discarding unblessed work. Per-file revert stays ungated (small, single
        file; native file history covers it). Verified live in the container.
  - [x] **Inline per-file diffs + colored stats** (matches `gui-stub-v4.png`).
        Engine `fileDiff(path, fromRef?)` (+ `lineDiff` in `diff-stats.ts`,
        `DiffLine`/`FileDiff` types) computes a signed line list base→workdir,
        lazily — only for the file pair, on expand. The panel renders `+N` green
        / `−N` red stats and expandable file rows: clicking a row fetches its
        diff (cached; cache cleared on reload, expansion persists) and renders
        the colored hunk. The filename stays a click-to-open link. +3 engine
        tests; verified live. (Was a parked "future feature" — now shipped.)
  - [ ] **Deferred polish (Phase 5):** richer peer/divergence UI; broader live
        assertions (restore-checkpoint, multi-device ingest); persist the
        workIndex across reloads (today it cold-primes once per session on the
        first touch/rescan); diff context capping for very large files.
- [~] **Phase 4 — Mobile (Android).** _Storage spike ✅ — the core unknown is
  de-risked in Node._
  - [x] **IndexedDB object-store spike** (`test/indexeddb-store.spike.test.ts`):
        the engine runs end-to-end with its **gitdir on IndexedDB** (LightningFS
        + `fake-indexeddb`) and the worktree on `node:fs`, composed by
        `createRoutingFs` — the exact mobile split. Proves onboard→edit→bless and
        a blob byte round-trip (revert reads bytes back out of the IDB baseline).
        Two real portability bugs the spike surfaced, now fixed:
        - **`mkdir({recursive})` is a node-ism** LightningFS doesn't honour
          (throws `EEXIST`, no parent creation). Added `fs-utils.ts`
          `ensureDir` (tolerant mkdirp over the minimal fs contract) and routed
          every injected-fs mkdir through it (`engine.ts` ×4, `local-state.ts`,
          `signal-store.ts`).
        - **`replica-id.ts` used static `node:fs/promises`** (one of the two
          flagged transitive leaks) → now takes the injected `fs`
          (`readOrCreateReplicaId(fs, gitDir)`; engine passes `this.fs`).
  - [x] **Buffer polyfill** (isomorphic-git needs a `Buffer` global, absent in
        the mobile WKWebView). Two consumers, two fixes (the bare-`'buffer'`
        builtin name defeats a plain `inject`): tsdown **aliases `buffer` → the
        feross `buffer/index.js`** so `safe-buffer`'s `require('buffer')` bundles
        the polyfill instead of externalising to the missing Node builtin; and
        `main.ts` does `globalThis.Buffer ??= <feross>` so iso-git's *free*
        `Buffer` global is filled on mobile (a no-op on desktop's native Buffer).
        `buffer` added to plugin deps (knip `ignoreDependencies` — it shadows the
        builtin name). Desktop unaffected; the live smoke exercises the bundled
        polyfill via `safe-buffer` during git-sha. On-device Android still
        unverified (only the desktop container is available here).
  - [ ] **Real mobile backends behind the router:** worktree→`app.vault.adapter`
        (as `fs.promises`), gitdir→LightningFS (live IndexedDB, not faked); wire
        the plugin to build them per-platform; drop `platform:'node'`/
        `isDesktopOnly`.
  - [x] **`state.ts` node:fs leak closed:** `readSeq`/`nextSeq`/`*BlessHighWater`
        now take the injected `fs` (mkdirp via `ensureDir`); engine call-sites pass
        `this.fs`. The mobile IndexedDB spike exercises this through `bless`.
  - [x] **`node:crypto` leak closed:** `replica-id.ts` no longer statically
        imports `node:crypto` (a load-time import would stop the engine loading
        in the mobile WKWebView). New `crypto-utils.ts` gives `randomId()`
        (`globalThis.crypto.randomUUID`) + a sync, dependency-free `sha256Hex()`
        (Web Crypto's `subtle.digest` is async; our callers are sync), proven
        byte-identical to `node:crypto` over the empty string, fixtures, unicode,
        and every 64-byte-block residue (`test/crypto-utils.test.ts`). The engine
        `src/` is now free of every node builtin except `node:path` (pure string
        ops, fine in WKWebView).
  - [ ] Sideload + Syncthing round-trip across the user's devices.
- [ ] **Phase 5 — Polish.** Peer/sync UX, packaging (later;
  community store is low priority).

### Resume here (session handoff)

**State:** branch `plan/p2p-bless-protocol`, worktree `.worktrees/p2p-bless`
(install deps there: `pnpm install`). Phase G ✅ + Phase-1 `fs`-injection ✅ +
**Phase-2 coordination core ✅** + **Phase-3 plugin integration ✅** (real-data
panel + **event-driven incremental hashing**, wired + live) + **composite routing
`fs` ✅** (Phase-1 close-out) + **mobile storage spike ✅** (gitdir on IndexedDB
via the router). Gates: `pnpm -r test` = **92** (65 engine / 9 cli / 18 plugin),
`pnpm -r typecheck`, `pnpm lint` (1 pre-existing warning only), `pnpm knip`,
engine + plugin `pnpm build`, and `pnpm test:plugin` (live headless smoke) all
pass.

**Latest increments (this session):**
1. **Composite routing `fs`** (`createRoutingFs`, `routing-fs.ts` +
   `test/routing-fs.test.ts`) — Phase-1 close-out; exported.
2. **Plugin builds its engine via `createRoutingFs`** (`main.ts`; desktop = both
   `node:fs`, behaviour-neutral — live `pnpm test:plugin` still passes).
3. **Mobile storage spike ✅** (`test/indexeddb-store.spike.test.ts`) — engine
   runs with the gitdir on IndexedDB (LightningFS + `fake-indexeddb`), worktree
   on `node:fs`, via the router; onboard→bless + blob round-trip proven. Fixed
   two portability bugs it surfaced: `fs-utils.ts` `ensureDir` (mkdirp; LightningFS
   ignores `{recursive}`) and `readOrCreateReplicaId(fs, …)` (was static node:fs).
   New engine devDeps: `@isomorphic-git/lightning-fs`, `fake-indexeddb`.

Suite: **92** (65 engine / 9 cli / 18 plugin); typecheck/lint/knip/builds green
(lint has 1 pre-existing *warning* only).

**Next step — Phase 4 continues (see the Phase-4 checklist above):**
1. **Buffer polyfill** via tsdown inject (mobile WKWebView lacks `Buffer`).
2. **Real mobile backends behind the router** (worktree→`app.vault.adapter`,
   gitdir→live LightningFS), per-platform wiring in `main.ts`, drop
   `platform:'node'`/`isDesktopOnly`.
3. Close the last **node:fs leak** (`state.ts`) + a mobile-safe `node:crypto`
   path in `replica-id.ts` (Web Crypto) before Android.
Smaller follow-ups: persist the `workIndex` across reloads.
2. Or **trim old machinery** now that the new path exists and is the product:
   `review-note.ts`, `changes-file.ts`, the engine's `snapshot`/`writeSnapshot`/
   `blessSnapshot`, the rotating-file bits of `replica-id.ts`, and `state.ts`'s
   `bless-hwm`/`snapshot-seq`. **Caution:** the CLI (`watch.ts`/`cli.ts`) still
   calls these; rip them out only with the CLI updated or those green packages
   break. The plugin no longer uses any of it.
3. Or finish **retention/GC** + the **crash-republish** gap (both noted under
   Phase 2 above), or **Phase 4 — Mobile** (after incremental hashing).

**Working references:** engine timeline API = `packages/engine/src/engine.ts`
(`timeline`/`listCheckpoints`/`restoreCheckpoint`) + `git-ops.ts`
(`walkChanges`/`readMarkerBlob` now take a `fromRef`) + `test/timeline.test.ts`.
Plugin = `packages/plugin/src/{main,review-view,format,settings}.ts` (real data;
`main.ts` is the `ReviewController`/`SettingsHost`; `format.buildPanelData` is
the DOM-free view-model seam). Live loop = `scripts/smoke-plugin.sh`
(`pnpm test:plugin`, asserts via `_OG/sync/` signal files); panel screenshot via
the overlay workaround (`pnpm shot:stub`; see memory
`headless-screenshot-deferred-view`). Coordination core unchanged. CLI
(`packages/cli`) is legacy.

**Watch-outs:**
- The signal folder is `_OG/sync/`; `_OG/` is git-ignored, so signals **sync
  but never commit** into the device-local store — keep it that way.
- Two notions of "pending" differ: `status().clean` is working-tree-vs-baseline;
  a bless *obligation* (`stillPending`) lives in `LocalState.pending`. A gated
  bless can leave status clean while the obligation persists (see the
  arrival-gate test).
- Engine is mobile-clean: `engine.ts`/`local-state.ts`/`signal-store.ts`/
  `replica-id.ts`/`state.ts` all use the injected `fs` (via `ensureDir` for
  mkdirp), and crypto goes through `crypto-utils.ts` (Web Crypto, no
  `node:crypto`). The only remaining node builtin is `node:path` (import-only,
  pure string ops, fine in WKWebView). Don't reintroduce a static
  `node:crypto`/`node:fs` import in the engine, and don't assume
  `{recursive:true}` mkdir anywhere — use `ensureDir`.
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

## Troubleshooting an Obsidian plugin (general tips)

Generic debugging playbook for Obsidian plugins (not specific to this one) —
drive everything through the **headless container**, never a real vault.

**First principles**
- **Reproduce in the container and trust it.** It is real Obsidian and behaves
  like the desktop app (it *can* mount main-area views, run plugins, etc.). If a
  "rig limitation" seems to explain a bug, be suspicious — it's usually your code.
- **Verify the build you're testing is the build you shipped.** 
  `sha256sum dist/main.js <vault>/.../main.js` must match.** Reload the plugin
  fresh from disk between iterations (`obs plugin:reload <id>`, or
  `disablePlugin`+`enablePlugin`; a full container restart is the most reliable).

**Inspecting live state via `obsidian eval`**
- `await`-ing `setViewState`/`revealLeaf` **inside** an `obs eval` can hang the
  eval (no output). Pattern that works: **fire the action without awaiting it**
  in the returned expression, `sleep`, then inspect in a **separate** `obs eval`.
- For multi-step async, wrap each step in `Promise.race([p, timeout])` so one
  hung call doesn't swallow the whole result.
- Capture logs/errors: `obs dev:debug on` then `obs dev:console [level=error]`;
  `obs dev:errors` is a separate buffer. Or instrument your code to push to a
  `window.__log` array and read it back with a later eval.
- Detaching leaves in eval can persist a broken `.obsidian/workspace.json` that
  survives restarts — `rm` it before booting for a clean slate.

**View won't render / panel is blank**
- Check whether the view actually **mounted**: `leaf.view._loaded === true` and
  the leaf's `containerEl` has a `workspace-leaf-content` child. If `_loaded` is
  false, Obsidian never called `load()`/`onOpen()` — the problem is *before* your
  render code, so adding logs inside `onOpen`/`render` won't help.
- If a view is constructed (`ctor` runs) but never loads, **suspect a member-name
  collision with the base class** (see Conventions) before blaming async/timing,
  deferred views, or the rig.

**Investigating mysterious behaviour (eg: blank panels, panels not loading)**
- Build a **minimal working `ItemView`** in the same plugin and confirm it mounts.
  Then **morph it toward the broken class one change at a time** — each step
  logged, behind try/catch, checking the error console — until it breaks. The
  change that flips it is the cause. (Conversely: strip the broken class down
  until it works.) Register several variants at once and probe them in a single
  run to save restart cycles.
- Hold **one variable at a time**: same registration, same open path, same vault
  state. Re-confirm your known-good control *each build* — don't assume it still
  works after an unrelated change.
- Consider **import/require side effects** as you add functionality: a newly
  imported module may run code at load time.
