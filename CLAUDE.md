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
- [ ] **Phase 1 — CLI + container.** Thin CLI over the engine, `watch` mode (chokidar). Doubles as Roastery service.
- [ ] **Phase 2 — Obsidian plugin.** Same engine; settings, native review panel, lifecycle, app-data wiring; community-store publish.
- [ ] **Phase 3 — Optional.** Claude integration layer; watcher-enacts-checkboxes; plugin-on-headless.

**Resume here:** Phase 1 — `packages/cli`: a thin CLI over the engine (`status`/`refresh`/`bless`/
`revert`/`rollback`/`tag`/`watch`), with a chokidar `watch` mode that calls `refresh()` on change.
Doubles as the Roastery container service. The engine API to wrap is in `packages/engine/src/index.ts`.

### Key design decisions (locked)
- git (not jj); own repo (coexists with Obsidian Git, no dependency on it).
- Marker = a branch named `baseline`; `HEAD` always points at it. Pending = `statusMatrix` (workdir vs marker).
- Ignores via `.git/info/exclude` (managed block), not a committed `.gitignore`. `.obsidian` plugins/settings tracked; `workspace*.json`/caches ignored.
- Review note written into `_Review/` inside the vault (git-ignored, sync-synced) so `[[links]]` resolve on mobile.
- isomorphic-git in all adapters for behavioral parity.
