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
- [~] **Phase 1 — Engine storage refactor.** Introduce `WorkingTree` +
  `ObjectStore` interfaces; port the existing isomorphic-git/node-fs logic onto
  them; baseline becomes a commit ref advanced per-path; add a `checkpoints`
  history; content-gated diff. Keep desktop green via Vitest. _← we are here._
- [ ] **Phase 2 — Coordination layer.** Synced `_OG/sync/` JSON
  (`bless-<id>` / `device-<id>`), `applyBless` (content gate + arrival defer),
  debounced ingest, crash-recovery (idempotent re-ingest), retention (last-N
  blessed + unblessed window), re-bootstrap from synced blesses.
- [ ] **Phase 3 — Plugin integration.** Wire engine + coordination into the
  Phase-G panel (real data); per-device activation; event-driven **incremental**
  hashing (mandatory — full rescans are too slow on mobile); settings.
- [ ] **Phase 4 — Mobile (Android).** IndexedDB `ObjectStore`; Buffer polyfill
  via tsdown inject; the spike (isomorphic-git + IndexedDB round-trip); drop
  `isDesktopOnly`; sideload + Syncthing round-trip across the user's devices.
- [ ] **Phase 5 — Polish.** Inline diffs, peer/sync UX, packaging (later;
  community store is low priority).

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
