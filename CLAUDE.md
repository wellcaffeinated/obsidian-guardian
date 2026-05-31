# Obsidian Guardian

> **Agent vault review.** Let agents (Claude, etc.) edit an Obsidian vault, then review
> exactly what changed since the last *blessed* state — a complete, trustworthy change list
> with per-file accept/revert, reviewable on mobile. The guarantee is **complete visibility +
> clean per-file undo**, not prevention.

## Canonical design

The full design lives in the user's Obsidian vault note **"Agent vault review — plan"**
(read it with `obsidian read file='Agent vault review — plan'`). That note is the source of
truth for intent; this file tracks how we're *building* it.

## Core concept (marker model)

One advanceable marker per vault, `baseline` = "last blessed state".
- **Pending** = `git diff baseline → working tree` (concurrency-agnostic).
- **Bless** = advance `baseline` to now. **Revert file** = restore one path from baseline.
- **Rollback** = reset tree to baseline. **Tag** = named snapshot.

The git database lives **outside** the synced vault tree (app-data / a separate `gitDir`),
so nothing git-related ever syncs to other devices. Ignores live in `.git/info/exclude`
(confirmed: isomorphic-git honors `info/exclude`, not just `.gitignore`).

## Architecture: one engine, many shells

`ReviewEngine` is a **pure TypeScript module with zero Obsidian imports** (Node `fs` +
isomorphic-git only). The same engine code runs unchanged in:
- the **CLI/container** adapter (test rig + Roastery service), and
- the **Obsidian plugin** adapter (desktop, `isDesktopOnly`).

Keeping the engine Obsidian-free is the load-bearing invariant. Never `import … from 'obsidian'`
in `packages/engine`.

## Repo layout (pnpm workspace monorepo)

```
packages/
  engine/        Phase 0 — pure ReviewEngine (this is the durable asset)
  cli/           Phase 1 — CLI + container adapter, watch mode (later)
  plugin/        Phase 2 — Obsidian plugin adapter (later)
```

## Commands

Root (run across all packages):
- `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm format` · `pnpm knip`

Per package (e.g. `packages/engine`): same scripts via `pnpm --filter @obsidian-guardian/engine <script>`.

End-to-end smoke tests (`scripts/`, shell):
- `pnpm test:smoke` — drives the **built** CLI through onboard→status→refresh→revert→bless
  against a throwaway temp vault (plus the outside-vault guard and `--replica-id` override).
  No docker; seconds.
- `pnpm test:docker` — full container path: builds the image, runs the watcher against the
  example vault via the real compose file, edits a file, asserts the review note updates and is
  written back host-owned, and that `docker compose exec guardian og bless` runs as the host
  user and refreshes the note. Needs the docker daemon.
- `pnpm test:plugin` — full plugin path: builds + loads the plugin in headless Obsidian
  (`obsidian-headless-container`), drives it over `docker exec`, asserts load/refresh/bless. Needs docker.
- `pnpm test:all` — `pnpm test && pnpm test:smoke` (the no-docker gate).
- `pnpm screenshot:plugin [out.png]` — capture the plugin's review panel running in headless
  Obsidian (default `screenshots/plugin-<timestamp>.png`); brings the container up / hot-reloads, leaves it running.
- Demo helpers: `pnpm demo:up` / `pnpm demo:down` / `pnpm demo:reset`.

**Each smoke pre-cleans before it runs** (host smoke wipes its temp workspace; `test:docker`/
`demo:reset` reset the demo vault + gitDir to the committed state), so a crashed prior run never
poisons the next. **Agents: run `pnpm test:smoke` to validate the built CLI before claiming it
works** — it exercises the bundled binary + arg parsing that the Vitest suites (run against `src`)
don't cover.

## Conventions

- **Package manager: pnpm** (not npm/yarn/bun — this overrides the global bun preference for
  this structured/publishable project).
- **Bundler: tsdown**; **tests: Vitest**; **lint/format: Biome**; **dead code: Knip**.
  Helper skills for these are installed under `.agents/skills` (symlinked into `.claude/skills`):
  `tsdown`, `vitest`, `knip`, `configure-workflows`, `release-please-*`. Use them.
- Engine tests run against **`src`** (vitest alias) for fast iteration; the published artifact
  is verified separately by `build` + `typecheck` (`isolatedDeclarations` requires explicit
  public types).
- **Named exports only**; all public exports re-exported from each package's `src/index.ts`.
- **Conventional Commits** (feat/fix/chore/…) — feeds Release Please later and doubles as a
  progress log.

## Status & progress

**Update this section at every milestone — it is the resume point across sessions.**

Phasing (de-risk hard logic in the easy environment first):

- [x] **Phase 0 — Engine core.** Pure TS module + Vitest against temp folders. **✅ green: 13/13 tests, typecheck, lint, knip, build all pass.**
  - [x] Repo init, monorepo scaffold, tooling, skills wired in.
  - [x] `types.ts`, `defaults.ts`.
  - [x] `git-ops.ts` (isomorphic-git wrappers: init, statusMatrix, commitAll, readBlob, checkout, writeRef).
  - [x] `diff-stats.ts` (line +/- counts, binary detection).
  - [x] `review-note.ts` (markdown render of Status).
  - [x] `engine.ts` (`ReviewEngine`: onboard/status/refresh/bless/revert/rollback/tag).
  - [x] `index.ts` exports.
  - [x] Tests written: onboard idempotent, status add/modify/delete/rename, bless advances marker,
        revert restores one file, rollback resets tree, ignores respected, review note content.
  - [x] `pnpm install`, green `build` + `test` + `typecheck` + `lint` + `knip`.
  - Notable engine decisions made during build:
    - Change detection is **content-based** via `git.walk(TREE(marker), WORKDIR)` hashing each file
      (collected through a side-effect accumulator, not `git.walk`'s return). This avoids isomorphic-git's
      index stat-cache shortcut, which silently missed *same-byte-length* edits.
    - Ignores use the **`ignore` package as the authoritative matcher** in the engine, *and* seed
      `.git/info/exclude` for cross-tool agreement (belt-and-suspenders — isomorphic-git's own ignore
      handling on an external gitdir proved unreliable).
    - revert/rollback **write baseline blob bytes directly** (not `git.checkout`, which also stat-skips).
    - `refresh()` returns `Status` (slightly richer than the plan's `void`) for adapter/test convenience.
  - Known follow-ups (not blockers): status hashes every non-ignored file each call (fine for a vault,
    optimise with a stat cache later); rename detection is exact-content only.
- [x] **Phase 1 — CLI + container.** Thin CLI over the engine, `watch` mode (chokidar). Doubles as Roastery service. **✅ green: 24/24 tests (17 engine + 7 cli), typecheck, lint, knip, build; demo + `test:smoke` + `test:docker` verified end-to-end.**
  - [x] `packages/cli` scaffold (tsdown two-entry: `index.ts` lib + `cli.ts` bin with shebang; vitest aliases engine→src; tsconfig paths→engine src; isolatedDeclarations build).
  - [x] `config.ts` — `resolveConfig` (flag → `OG_*` env → default; git-dir defaults to sibling `<vault>.gitdir`; asserts git-dir is outside the vault).
  - [x] `commands.ts` — `createEngine` (auto-onboards, idempotent) + `formatStatus` (terminal summary).
  - [x] `watch.ts` — `runWatch`: chokidar over the vault, debounced `refresh()`, serialized (running/dirty lock), **ignores its own `_OG/` writes** (no refresh loop), `--poll` for bind-mount reliability.
  - [x] `cli.ts` — `node:util.parseArgs` dispatch for `onboard/status/refresh/bless/revert/rollback/tag/watch`; `--json` status; `--replica-id`/`--review-folder` overrides; SIGINT/SIGTERM clean stop.
  - [x] Tests: config precedence + outside-vault guard; `formatStatus`; watch writes note on initial pass + after a change; watch never reacts to its own output. Engine: per-replica note name (shape, persistence across instances, differs per gitDir, explicit-id override).
  - [x] Container: root `Dockerfile` (node:22-slim, corepack pnpm + `gosu`, build workspace), `docker-entrypoint.sh` (start root, chown gitdir, then `exec og`) + `docker-og.sh` → `/usr/local/bin/og` (the gosu drop to PUID/PGID; also the short command for `docker compose exec`), default `CMD watch --poll`; `.dockerignore`.
  - [x] `docker-compose.example.yaml` + `example/` demo: seed vault at `example/vaults/demo`, git-dir bind-mounted **outside** the vault at `example/.gitdir` (tracked `.gitkeep`, contents ignored), `_OG/` ignored, `PUID/PGID` (default 1000) so notes are written host-owned. (No `/etc/machine-id` mount — the review filename is keyed to the per-replica id persisted in the gitDir.)
  - [x] Root `og` script (`pnpm og <cmd>`, host Node) drives the demo vault from the host for bless/revert/rollback/tag — distinct from the in-image `og` shim.
  - [x] Smoke scripts (`scripts/`, shell): `test:smoke` (host CLI lifecycle, no docker), `test:docker` (container watch + `exec og bless`), shared `lib.sh` (assert/wait_for/reset_demo); each pre-cleans so a crashed run can't poison the next.
  - Notable Phase-1 decisions:
    - Arg parsing via **built-in `node:util.parseArgs`** (zero deps); only runtime dep added is `chokidar` v4.
    - Watcher **must** ignore the review folder or writing the note retriggers refresh forever — covered by a regression test.
    - `--poll` defaulted in the demo: polling reliably sees host edits across the Docker bind-mount regardless of inotify propagation.
    - **Review folder default `_OG`** (configurable via `--review-folder`/`OG_REVIEW_FOLDER`). **Review filename is per-replica: `changes-<12-hex>.md`**, hash of a replica id. The id is a random UUID persisted at `<gitDir>/obsidian-guardian/replica-id` (engine `replica-id.ts`, `readOrCreateReplicaId`, exclusive `wx` create so concurrent fresh onboards converge). Resolved lazily at `onboard()` (gitDir must exist first); `ReviewEngine.reviewNoteName` is valid thereafter. Per-replica (= per-gitDir, 1:1 with vault), which is exactly the collision-avoidance unit — two replicas of one synced vault never share a file. No hardware probing, no OS branch, no container mount. Override the seed via `--replica-id`/`OG_REPLICA_ID`/`EngineConfig.replicaId`.
    - Container drops root→host user the **linux-server way** (`gosu` + `PUID`/`PGID`), not a static compose `user:`. Verified: review note written back owned by the host user. Management commands: `docker compose run --rm guardian <cmd>` (through the entrypoint) or, against a running watcher, `docker compose exec guardian og <cmd>` — `og` is a PATH shim (`docker-og.sh`) that re-does the gosu drop so `exec` runs as the host user with a short command.
    - **`bless`/`revert`/`rollback` refresh the review note** themselves (CLI layer). `bless` changes no vault files, so a running watcher wouldn't re-render the note otherwise; this keeps a one-shot management command's output correct without a watcher.
    - Demo verified live: container watch → host edit → debounced refresh → updated `_OG/changes-<hash>.md`; filename stable across restart (persisted id), identical between container and host `pnpm og` over the shared gitDir; bless/revert/rollback all work.
- [~] **Phase 2 — Obsidian plugin.** Same engine; `packages/plugin` (`isDesktopOnly`). **First slice ✅ green: 40 tests (17 engine + 7 cli + 16 plugin), typecheck, lint, knip, build; live plugin smoke passes in the headless container.** First slice = configure + see changes + bless + rollback; per-file revert/tag deliberately deferred (native file history covers single files).
  - [x] `packages/plugin` scaffold: `manifest.json` (`isDesktopOnly: true`), tsdown emits CJS `main.js` (`format:['cjs']`, `outExtensions js:'.js'`, `deps.alwaysBundle:[/.*/]` + `neverBundle:['obsidian','electron']` so the bundle is self-contained and node builtins resolve to Electron's Node), `build:done` hook copies `manifest.json`+`styles.css` into `dist/`. `obsidian` is a devDep (external).
  - [x] `config.ts` — `resolvePluginConfig`: `vaultPath` from `FileSystemAdapter.getBasePath()`, `gitDir` under **OS app-data** (`~/.local/share`|`Application Support`|`%APPDATA%`) keyed by `sha256(vaultPath)` so it's per-machine/per-vault and OUTSIDE the synced tree; ports the outside-vault assert. Persisted settings override.
  - [x] `watcher.ts` (Obsidian-free, ported from `watch.ts`): `createSerializedRefresh` (dirty-flag), `shouldIgnorePath` (ignore `_OG/` + `.obsidian/` or rendering the note re-triggers refresh), `createDebouncer`. `format.ts`: pure `Status`→rows for the panel (the DOM-free unit-test seam).
  - [x] `review-view.ts` — `ReviewView` (ItemView) opened as a **main-area tab** (vault-wide, not a sidebar) via `workspace.getLeaf(true)`; header (baseline short-SHA, clean/active), Refresh/Bless/Roll-back buttons, change list; `ConfirmModal` gates rollback. `settings.ts` — `GuardianSettingTab` (ignores/marker/author/review-folder/gitDir/replicaId; rebuilds engine on `hide()`).
  - [x] `main.ts` — `ObsidianGuardianPlugin` implements the view controller + settings host: `onLayoutReady`→`initEngine` (new `ReviewEngine`→`onboard`→`refresh`), debounced refresh on `vault.on(modify/create/delete/rename)`, commands (open/refresh/bless/rollback), ribbon + clickable status-bar.
  - [x] Live rig: `docker-compose.plugin-test.yaml` (image `ghcr.io/wellcaffeinated/obsidian-headless-container`, single vault mount), seed `example/plugin-vault/`, `scripts/smoke-plugin.sh` + `pnpm test:plugin` (build→copy plugin in→enable→assert load+no errors→screenshot→edit reflects→bless clears), `reset_plugin` in `lib.sh` (pre-clean + teardown).
  - Notable Phase-2 decisions / gotchas:
    - **Engine runs unchanged on desktop**: its `node:fs`/`node:path`/`node:os`/`node:crypto` resolve to Electron's Node; `isDesktopOnly` keeps it off mobile (mobile stays view-only via the synced note).
    - **Test only in the headless container, never the real Obsidian.** Drive it with `docker exec <container> obsidian <cmd>` (skip the ssrv socket/shim). The container defaults to **Restricted Mode**: the master switch is the `enable-plugin-<appId>` **localStorage** flag — set it directly + `loadManifests()` + `enablePlugin(id)`, and **retry** (idempotent) because `obs version` can succeed a beat before the plugins API is ready.
  - [ ] Remaining for Phase 2: per-file revert + tag in the panel; community-store packaging (release-please for the plugin, versioned `manifest.json`/`versions.json`); broader live assertions (rollback, mobile-emulation read of the note).
- [ ] **Phase 3 — Optional.** Claude integration layer; watcher-enacts-checkboxes; plugin-on-headless.

**Resume here:** Phase 2 polish — extend `packages/plugin`: add per-file **revert** (`engine.revert(path)`) and
**tag** to the panel/commands, then wire community-store packaging (release-please + `versions.json`). The
slice (load/onboard/panel/bless/rollback/watch) is built and green; the working references are
`packages/plugin/src/{main,review-view,config,watcher}.ts` and the live loop in `scripts/smoke-plugin.sh`
(`pnpm test:plugin`). Engine API: `packages/engine/src/index.ts`; CLI adapter: `packages/cli`.

### Key design decisions (locked)
- git (not jj); own repo (coexists with Obsidian Git, no dependency on it).
- Marker = a branch named `baseline`; `HEAD` always points at it. Pending = `statusMatrix` (workdir vs marker).
- Ignores via `.git/info/exclude` (managed block), not a committed `.gitignore`. `.obsidian` plugins/settings tracked; `workspace*.json`/caches ignored.
- Review note written into `_OG/` inside the vault (configurable; git-ignored, sync-synced) so `[[links]]` resolve on mobile. Filename `changes-<replica-hash>.md` — **per-replica** (hash of a random id persisted in the gitDir), to avoid sync conflicts when the same vault is reviewed from multiple replicas/devices.
- isomorphic-git in all adapters for behavioral parity.
