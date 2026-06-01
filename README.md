# Obsidian Guardian

> **Agent vault review.** Let agents (Claude and friends) edit your Obsidian
> vault, then review _exactly_ what changed since the last state you trusted — a
> complete, honest change list with per-file revert. The guarantee is **complete
> visibility + clean undo**, not prevention.

You point Obsidian Guardian at a vault. It remembers the last **blessed** ("last
reviewed and trusted") state and continuously writes a **review note** into the
vault listing everything that has changed since. When you're happy, you
**bless** to advance the marker; if something is wrong, you **revert** a single
file or **rollback** the whole vault. Because the review note lives inside the
vault, it syncs to your phone — so you can see what changed from anywhere.

The git database that powers all this lives **outside** the vault, so nothing
git-related ever syncs to your other devices.

> **Status:** the Docker container / CLI is ready to use. An **Obsidian plugin**
> (desktop UI for the same engine) is under active development — _coming soon_.

---

## How it works

One advanceable marker per vault, `baseline` = "last blessed state":

- **Pending** = the diff from `baseline` → your working tree.
- **Bless** = advance `baseline` to now (you've reviewed and accepted
  everything).
- **Revert `<file>`** = restore one path from the baseline.
- **Rollback** = reset the whole tree to the baseline.
- **Tag** = a named snapshot.

The watcher regenerates a review note (`_OG/changes-<id>.md` by default) on
every change, so the note always reflects the current pending set.

---

## Quick start with Docker

The container runs a long-lived **watcher** over a mounted vault and regenerates
the review note whenever a file changes. The image is published to GHCR:

```
ghcr.io/wellcaffeinated/obsidian-guardian
```

### docker compose (recommended)

```yaml
services:
  guardian:
    image: ghcr.io/wellcaffeinated/obsidian-guardian:latest
    environment:
      # Write review notes back to the host as YOU, not root.
      # Set these to your `id -u` / `id -g`.
      PUID: ${PUID:-1000}
      PGID: ${PGID:-1000}
    volumes:
      # Your vault (the work-tree). Edits here are reviewed; the review note is written back here.
      - /path/to/your/vault:/vault
      # The git database — OUTSIDE the vault, so it never syncs. Keep it on a host path
      # so it survives restarts.
      - /path/to/guardian-gitdir:/gitdir
    command: ["watch", "--poll", "--debounce", "300"]
    init: true
```

Start it (passing your own user so files come back owned by you):

```sh
PUID=$(id -u) PGID=$(id -g) docker compose up -d
```

Now edit any note in your vault and watch `_OG/changes-<id>.md` appear/update
inside the vault.

> **Why a separate `/gitdir` mount?** The git history must live _outside_ the
> synced vault tree, or it would sync to every device. Keep it on a host path
> (or a named volume) — never inside the vault folder. The container refuses to
> run with a gitDir inside the vault.

> **Why `--poll`?** Filesystem event propagation across Docker bind mounts is
> unreliable; polling reliably sees your host edits. Drop it if you're confident
> inotify works in your setup.

### Running management commands

The image exposes a short `og` shim on PATH. Against a **running** watcher, exec
into it:

```sh
# See pending changes
docker compose exec guardian og status

# Accept everything — advance the baseline to the current state
docker compose exec guardian og bless

# Restore one file from the baseline
docker compose exec guardian og revert "Daily/2026-05-31.md"

# Restore the entire vault to the baseline
docker compose exec guardian og rollback

# Named snapshot at the current baseline
docker compose exec guardian og tag before-big-refactor
```

For a **one-shot** command without a running watcher, use `run --rm` (it goes
through the same entrypoint, so PUID/PGID and the gitDir chown still apply):

```sh
docker compose run --rm guardian status
docker compose run --rm guardian bless
```

The `og` shim re-applies the host-user privilege drop, so files written by
`bless`/`revert`/ `rollback` stay owned by you, not root.

### docker run (no compose)

```sh
docker run -d --name guardian \
  -e PUID=$(id -u) -e PGID=$(id -g) \
  -v /path/to/your/vault:/vault \
  -v /path/to/guardian-gitdir:/gitdir \
  --init \
  ghcr.io/wellcaffeinated/obsidian-guardian:latest \
  watch --poll --debounce 300

docker exec guardian og status
docker exec guardian og bless
```

---

## CLI reference

The container's command is just the CLI. The same commands work locally
(`node cli.mjs <command>`) and via `og` inside the container.

```
Commands:
  onboard            Initialise the repo and set the baseline to the current state
  status             Print pending changes since the baseline
  refresh            Recompute status and (re)write the review note
  bless              Advance the baseline to the current state
  revert <path>      Restore one vault-relative path from the baseline
  rollback           Restore the whole vault to the baseline
  tag <name>         Write a named snapshot (tag) at the current baseline
  watch              Refresh the review note on every change (long-running)

Options:
  --vault <path>          Vault folder            (default: $OG_VAULT or cwd)
  --git-dir <path>        Git database, OUTSIDE the vault (default: <vault>.gitdir)
  --review-folder <name>  Review-artifact folder  (default: _OG)
  --replica-id <id>       Override the per-replica review filename seed
  --json                  Machine-readable JSON output (status)
  --poll                  Use polling for fs events (watch; bind-mount safe)
  --debounce <ms>         Debounce window for watch refreshes (default: 300)
  -h, --help              Show this help
```

### Configuration

Each option can be set by flag, environment variable, or default (in that order
of precedence):

| Setting       | Flag              | Env var            | Default                     |
| ------------- | ----------------- | ------------------ | --------------------------- |
| Vault         | `--vault`         | `OG_VAULT`         | current directory           |
| Git database  | `--git-dir`       | `OG_GIT_DIR`       | `<vault>.gitdir` (sibling)  |
| Review folder | `--review-folder` | `OG_REVIEW_FOLDER` | `_OG`                       |
| Replica id    | `--replica-id`    | `OG_REPLICA_ID`    | random, persisted in gitDir |

The review note filename is `changes-<hash>.md`, where the hash derives from a
**per-replica id** randomly generated and persisted inside the gitDir. This
keeps the filename stable across restarts and unique per replica, so reviewing
the same synced vault from multiple devices never produces conflicting note
files.

---

## What gets tracked vs. ignored

- `.obsidian` plugin and settings files **are** tracked (you usually want to
  review those).
- Caches and `workspace*.json` are ignored.
- The review folder (`_OG/`) is ignored — otherwise writing the note would
  retrigger the watcher.

Ignores are managed via the repo's `.git/info/exclude`, not a committed
`.gitignore` in your vault.

---

## Try the demo

The repo ships an example vault and compose file:

```sh
pnpm demo:up      # build + watch ./example/vaults/demo
# edit a file under example/vaults/demo, watch the review note update
pnpm demo:down
pnpm demo:reset   # restore the demo vault + gitDir to the committed state
```

---

## Coming soon: the Obsidian plugin

A desktop Obsidian plugin runs the **same engine** with a native UI — a review
panel with the change list, and Bless / Rollback / per-file Revert buttons, all
inside Obsidian. Reviewing is opt-in per machine (the plugin never silently
starts tracking on a synced device). It's built and working in tests; packaging
for the community store is in progress.

---

## License

See repository for license details.
