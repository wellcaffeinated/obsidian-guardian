# Obsidian Guardian

> Review what changed in your Obsidian vault since the last _blessed_ state, and
> roll back — entirely inside Obsidian, on every device. No server, no designated
> "git manager." Each device tracks changes in its own local (never-synced) git;
> devices coordinate the _trust marker_ ("blessed up to here") through small
> synced JSON files. Mobile is a first-class participant, not a viewer.

**This file is orientation for developing the repo.** For the product itself read
`README.md`. The three other docs:

- **[`plans/p2p-bless-protocol.md`](plans/p2p-bless-protocol.md)** — the
  protocol spec (data shapes, the content-gated apply rule, storage model,
  retention, mobile). Source of truth for _intent_; read it before touching the
  coordination layer.
- **[`plans/future-plugin-work.md`](plans/future-plugin-work.md)** — outstanding
  work (mobile verification, retention/GC, crash-republish, auto-checkpointing,
  polish, packaging).
- **[`plans/build-history.md`](plans/build-history.md)** — how the plugin was
  built (the phased rewrite log); archaeology only, not a spec.

## The model in five sentences

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

## Architecture: one engine, injected storage

`ReviewEngine` is a **pure TS module with zero `obsidian` imports**. Its storage
is **dependency-injected** so it runs on desktop and mobile:

- **Working tree** — list/read/write vault files. Impl: `node:fs` (desktop) or
  `app.vault.adapter` (plugin; works on Android).
- **Object store** — content-addressed git db (blob/tree/commit/ref),
  **device-local, never synced**. Impl: isomorphic-git over `node:fs` (desktop)
  or over IndexedDB (mobile, via LightningFS).

`createRoutingFs` composes the two into one `PromiseFsClient` the engine sees:
paths under `gitDir` → object store, everything else → working tree. Only the
content **Hash** (git blob sha) must agree across devices; each store is private,
so on-disk format need not.

**Keeping the engine `obsidian`-free is the load-bearing invariant.** Never
`import … from 'obsidian'` in `packages/engine`.

## Repo layout (pnpm workspace)

```
packages/
  engine/   pure ReviewEngine — the durable, storage-injected core
  plugin/   THE product — Obsidian plugin (desktop + Android); the GUI panel
plans/      design spec, future work, build history (see top of this file)
scripts/    headless-Obsidian smoke + screenshot helpers
```

### Key modules

- Engine coordination: `engine.ts` (`bless`/`applyBless`/`ingest`/`recover`/
  `timeline`/`checkpoint`/`restoreCheckpoint`/`fileDiff`), `signal-store.ts`
  (`_OG/sync/` JSON), `local-state.ts`, `git-ops.ts` (tree overlay), `routing-fs.ts`,
  `crypto-utils.ts` / `fs-utils.ts` (mobile-safe primitives).
- Plugin: `main.ts` (the `ReviewController`/`SettingsHost`; wiring, commands,
  watchers), `review-view.ts` (the panel + `ConfirmModal`), `format.ts`
  (`buildPanelData` — the DOM-free view-model seam), `settings.ts`,
  `config.ts` / `desktop-env.ts` / `adapter-fs.ts` (per-platform env).

## Commands

- `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format` ·
  `pnpm knip` (root = all packages; per-pkg via
  `pnpm --filter @obsidian-guardian/<pkg> <script>`).
- `pnpm test:plugin` — full plugin smoke in the headless container. **Needs docker.**
- `pnpm screenshot:plugin [out.png]` / `pnpm shot:stub` — build + load the plugin
  in headless Obsidian and capture the panel (the `shot:stub` variant uses an
  overlay workaround for Obsidian deferred views). **Needs docker.**

The merge gate is: `pnpm -r test`, `pnpm -r typecheck`, `pnpm lint` (one
pre-existing CSS specificity _warning_ is acceptable), `pnpm knip`, engine +
plugin builds, and `pnpm test:plugin` all green.

## Conventions

- **pnpm** (not npm/yarn/bun). **tsdown** bundler · **Vitest** · **Biome**
  lint/format · **Knip** dead-code. Helper skills under `.claude/skills`
  (`tsdown`, `vitest`, `knip`, …) — use them.
- **Named exports only**; re-export from each package's `src/index.ts`.
- **Conventional Commits** (feat/fix/chore/…).
- Engine tests run against **`src`** (vitest alias) for fast iteration; the
  published artifact is verified separately by `build` + `typecheck`
  (`isolatedDeclarations` requires explicit public types).
- **Never shadow a base-class member when extending an `obsidian` class.** When
  you `extends ItemView` / `View` / `Plugin` / `Modal` / `Component` / etc., your
  instance **fields and methods share one namespace with the base class's own
  fields/methods** — and Obsidian's runtime classes have many _undocumented_
  members not in `obsidian.d.ts`. A collision is silent and brutal: e.g. a
  `ReviewView` field named `open` made Obsidian construct the view but **never
  call `onOpen()`** (blank panel, no error). Defend against it:
  - Give view/plugin state **specific, namespaced field names** (`openCheckpoints`,
    not `open`; `diffCache`, not `cache`). Avoid bare generic names — `open`,
    `view`, `app`, `leaf`, `icon`, `scope`, `navigation`, `containerEl`,
    `contentEl`, `state`, `load`, `update`, `setState`/`getState`, `register*`,
    `on*` — on any subclass of an `obsidian` class.
  - Only **intentionally** override base methods (`onOpen`, `onClose`, `onload`,
    `onunload`, `getViewType`, `getDisplayText`, `getIcon`, `setState`); mark them
    `override` so the compiler flags a name that unexpectedly _does_ match the
    base (and conversely a typo'd override that silently doesn't).

## Locked decisions

- Symmetric, **server-less**: every device runs the engine over its own
  never-synced git; the only cross-device channel is synced JSON signal files.
- **Coordinate the marker, not git state.** Bless = content-hash delta manifest;
  apply is per-file content-gated ⇒ idempotent/commutative ⇒ no vector clock, no
  CRDT library. The post-sync working tree is the conflict arbiter.
- **Baseline = a commit ref**; advancing = new tree (old baseline ⊕ blessed
  paths) + atomic ref move. Lean on isomorphic-git for storage everywhere.
- **One file per device** in `_OG/sync/` (single-writer) ⇒ no Syncthing
  conflict files. `_OG/` is git-ignored (ignores via `.git/info/exclude`), so
  signals **sync but never commit** into the device-local store.
- **gitDir / object store never inside the vault** (Syncthing would corrupt it):
  app-data on desktop, IndexedDB on mobile. Device-local store loss ⇒ graceful
  **re-bootstrap** from synced blesses, never loss of the trust marker.
- **Reviewing is opt-in per device** (the local store's existence is the
  non-synced activation flag); installing the plugin doesn't auto-start a
  competing history.
- **Sync = Syncthing** for this user (not Obsidian Sync): syncs everything on
  disk incl. dot-folders, no toggles. **Targets: desktop (Linux) + Android**;
  iOS is best-effort/low-priority. **Self-install** (copy `dist/` into the
  vault's plugins folder; Syncthing propagates it) — no community store yet.
- **Auto-checkpointing** (when built) is a toggleable, off-by-default setting that
  snapshots only — it **never** advances the `baseline` (no auto-bless). The
  manual `Checkpoint` button is always available.

## Engine invariants — don't regress these

- **Mobile-clean.** The engine `src/` uses the injected `fs` (a `PromiseFsClient`)
  everywhere and goes through `crypto-utils.ts` (Web Crypto) — the only remaining
  node builtin is `node:path` (import-only, pure string ops, fine in WKWebView).
  **Don't reintroduce a static `node:fs`/`node:crypto`/`node:os` import in the
  engine**, and **don't assume `{recursive: true}` mkdir** (LightningFS ignores it)
  — use `ensureDir`. In the plugin, keep `node:fs`/`node:os` inside `desktop-env.ts`
  behind a runtime `require` (never a top-level import — it evals at load on mobile).
- **Two notions of "pending" differ.** `status().clean` is working-tree-vs-baseline;
  a bless _obligation_ (`stillPending`) lives in `LocalState.pending`. A gated
  bless can leave status clean while the obligation persists.

## Testing the plugin (hard-won gotchas)

- **Only ever test in the headless container, never the user's real Obsidian.**
  Drive via `docker compose -f docker-compose.plugin-test.yaml exec -T obsidian
  obsidian <cmd>` (see `scripts/lib.sh`). Plugin id is `obsidian-guardian`.
- Container starts in **Restricted Mode**: enable via the `enable-plugin-<appId>`
  localStorage flag + `loadManifests()` + `enablePlugin(id)`, and **retry** (the
  plugins API lags `obs version` readiness).

## Troubleshooting an Obsidian plugin (general playbook)

Drive everything through the **headless container**, never a real vault.

**First principles**

- **Reproduce in the container and trust it.** It is real Obsidian and behaves
  like the desktop app (it _can_ mount main-area views, run plugins, etc.). If a
  "rig limitation" seems to explain a bug, be suspicious — it's usually your code.
- **Verify the build you're testing is the build you shipped:**
  `sha256sum dist/main.js <vault>/.../main.js` must match. Reload the plugin fresh
  from disk between iterations (`obs plugin:reload <id>`, or `disablePlugin` +
  `enablePlugin`; a full container restart is the most reliable).

**Inspecting live state via `obsidian eval`**

- `await`-ing `setViewState`/`revealLeaf` **inside** an `obs eval` can hang the
  eval (no output). Pattern that works: **fire the action without awaiting it** in
  the returned expression, `sleep`, then inspect in a **separate** `obs eval`.
- For multi-step async, wrap each step in `Promise.race([p, timeout])` so one hung
  call doesn't swallow the whole result.
- Capture logs/errors: `obs dev:debug on` then `obs dev:console [level=error]`;
  `obs dev:errors` is a separate buffer. Or push to a `window.__log` array and read
  it back with a later eval.
- Detaching leaves in eval can persist a broken `.obsidian/workspace.json` that
  survives restarts — `rm` it before booting for a clean slate.

**View won't render / panel is blank**

- Check whether the view actually **mounted**: `leaf.view._loaded === true` and
  the leaf's `containerEl` has a `workspace-leaf-content` child. If `_loaded` is
  false, Obsidian never called `load()`/`onOpen()` — the problem is _before_ your
  render code, so logs inside `onOpen`/`render` won't help.
- If a view is constructed (`ctor` runs) but never loads, **suspect a member-name
  collision with the base class** (see Conventions) before blaming async/timing,
  deferred views, or the rig.

**Investigating mysterious behaviour (blank panels, panels not loading)**

- Build a **minimal working `ItemView`** in the same plugin and confirm it mounts.
  Then **morph it toward the broken class one change at a time** — each step
  logged, behind try/catch, checking the error console — until it breaks. The
  change that flips it is the cause. (Conversely: strip the broken class down until
  it works.) Register several variants at once and probe them in one run.
- Hold **one variable at a time**: same registration, same open path, same vault
  state. Re-confirm your known-good control _each build_.
- Consider **import/require side effects**: a newly imported module may run code at
  load time (fatal on mobile if it touches a Node builtin).
