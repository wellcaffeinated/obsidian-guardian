# Plan: multi-vault watcher (one container, many vaults)

> **Status:** design only — not yet implemented.
> **Motivation:** run a single container that watches several vaults
> bind-mounted under one `/vaults` directory, instead of one
> container/service per vault. Each vault still gets its own independent git
> repo (gitDir) and review note.

## Key fact: the engine needs zero changes

`ReviewEngine` is already strictly per-vault (one vault + one gitDir) and
Obsidian-free, and the per-gitDir replica-id already gives each vault its own
`changes-<hash>.md` with no cross-vault collision logic. So multi-vault is
purely a **multiplexing layer in the CLI/container** — the durable asset
(`packages/engine`) is untouched. Single-vault mode stays exactly as-is; this is
**additive**.

## Scope (decided)

- **Static discovery.** Enumerate vaults under `/vaults` **at startup**; one
  watcher per vault. Adding/removing a vault folder requires a restart. Dynamic
  (live) discovery is an explicit out-of-scope follow-up (see below).
- **Mutating commands require a vault argument.** `bless`/`revert`/`rollback`/
  `tag` must name their target vault in multi-vault mode; there is no
  "operate on all" default (too dangerous).

## Model

```
/vaults/
  personal/        ← a vault (work-tree)
  work/            ← a vault
  notes/           ← a vault
/gitdir/           ← git-root (the ONE gitDir parent mount)
  personal/        ← gitDir for /vaults/personal   (created by the watcher)
  work/
  notes/
```

- One vault = one subdirectory of the vaults-dir.
- Its gitDir = `<git-root>/<vault-folder-name>`. Folder names under one
  `/vaults` are unique by construction, so the name is a safe, human-readable
  key (no hashing needed here, unlike the plugin's app-data path).
- **Invariant preserved:** each gitDir is outside its vault, and two vaults
  never share a gitDir.

## Config layer

New multi-vault inputs, alongside the existing single-vault `--vault` /
`--git-dir` (which stay and take precedence when present):

| Setting        | Flag           | Env var          |
| -------------- | -------------- | ---------------- |
| Vaults root    | `--vaults`     | `OG_VAULTS_DIR`  |
| Git root        | `--git-root`   | `OG_GIT_ROOT`    |

Resolution (new `resolveMultiConfig`, leaving `resolveConfig` untouched):

1. `readdirSync(vaultsDir)`, keep directories, skip hidden/dotfiles.
2. For each, build a `ResolvedConfig` with
   `vaultPath = <vaultsDir>/<name>`, `gitDir = <gitRoot>/<name>`, inheriting
   `reviewFolder` / ignores / etc.
3. Reuse the existing `assertOutsideVault` per vault, **plus** a new assert that
   `gitRoot` is not nested inside `vaultsDir` (and vice-versa).

Mode selection: if `--vaults`/`OG_VAULTS_DIR` is set → multi-vault; else the
current single-vault path. (If both single and multi inputs are set, error
rather than guess.)

## Engine registry

A thin `createEngines(configs): Promise<Map<string, ReviewEngine>>` that loops
the existing `createEngine` (auto-onboard, idempotent) over the discovered
configs, keyed by vault folder name. No engine code changes.

## Watch layer

`runWatchMany(engines, configs, opts)`:

- Call the **existing** `runWatch` once per vault, collect the handles.
- Each vault keeps its own debounce window, serialized refresh + dirty-lock, and
  `_OG/` self-ignore for free (all already per-instance).
- A single SIGINT/SIGTERM handler closes every handle, then exits.

Rejected alternative: one chokidar watcher over `/vaults` with path→vault
routing. More code, shared-debounce headaches, worse isolation — N independent
watchers is simpler and each vault is fully insulated from the others.

## CLI surface (the real design work)

```
og watch                       # multi mode: watch ALL discovered vaults
og status                      # summary across all vaults (per-vault clean/▵counts)
og status <vault>              # one vault, as today
og status --json               # machine-readable, keyed by vault name
og bless <vault>               # REQUIRED arg in multi mode
og revert <vault> <path>
og rollback <vault>
og tag <vault> <name>
```

- In multi-vault mode a mutating command **without** a vault name errors with
  the list of available vaults (no implicit fan-out).
- In single-vault mode the commands keep today's argument shape exactly — the
  vault selector only appears when `--vaults` is in play.
- Every one-shot mutating command still `refresh()`es that vault's note
  afterward (as today), so the note is correct without a running watcher.

This is where most of the surface area lives: arg parsing, the "which vault"
resolution, help text, and clear errors. The engine/watch parts are small.

## Docker glue

- Mounts collapse to two parents: `- /host/vaults:/vaults` and
  `- /host/gitdirs:/gitdir`, with `command: ["watch", "--poll"]`.
- `docker-entrypoint.sh` already chowns `OG_GIT_DIR`; point it at the git-root
  (it recurses, so per-vault subdirs are covered). The `og` shim is unchanged —
  management commands become `docker compose exec guardian og bless work`.
- New `docker-compose.multivault.example.yaml` + a multi-vault section in the
  README.

## Test plan (when implemented)

- `resolveMultiConfig`: discovers subdirs, maps gitDirs, skips hidden, errors on
  nested git-root and on mixed single+multi inputs.
- `runWatchMany`: an edit in vault A refreshes **only** A's note, never B's;
  clean shutdown closes all watchers.
- CLI: `bless` without a vault errors in multi mode; `bless <vault>` blesses only
  that vault; `status --json` is keyed by vault.
- Extend `test:smoke` (and `test:docker`) with a two-vault `/vaults` layout
  driven through the built CLI.

## Out of scope (follow-ups)

- **Dynamic discovery** — watching `/vaults` for added/removed vault folders and
  spinning engines up/down live (race conditions, partial-onboard handling).
  +1-2 days; deferred. Static + restart covers the common case (vault sets
  change rarely).
- **Cross-vault batch ops** (`--all`) — deliberately omitted; a vault arg is
  always required for mutations.
- Per-vault config overrides (different ignores/marker per vault) — single
  global config applies to every discovered vault for now.

## Rough estimate

~**2-3 days**, low risk. Complexity is concentrated in CLI command-routing UX,
not the engine (unchanged) or the watch loop (a thin loop over the existing
`runWatch`).
