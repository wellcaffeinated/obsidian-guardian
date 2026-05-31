# Example: watch a demo vault

A tiny end-to-end demo of Obsidian Guardian. A container watches the demo vault
and regenerates its review note whenever a file changes.

## Run it

From the repo root:

```sh
docker compose -f docker-compose.example.yaml up --build
```

Then, in another terminal or your editor, change any file under
`example/vaults/demo/` — add a note, edit a line, delete a file. Within a moment
the review note updates:

```
example/vaults/demo/_OG/changes-<hash>.md
```

The `_OG/` folder holds review artifacts; the `<hash>` identifies this *replica*
(this git database), so two devices reviewing the same synced vault each write
their own file and never collide. The note lists every file that changed since
the last *blessed* baseline, with `+x -y` line counts and tappable
`[[wikilinks]]` (so it's reviewable in Obsidian on mobile too).

The container logs each refresh, e.g.:

```
2 changes since baseline 69da9fa:
  add      idea.md  +1 -0
  modify   Welcome.md  +3 -1
```

## Accept or undo changes (from the host)

Build once (`pnpm build`), then drive the same vault from the host:

```sh
pnpm og status      # show what's pending
pnpm og bless       # accept everything — advance the baseline to now
pnpm og revert Ideas.md   # restore one file from the baseline
pnpm og rollback    # restore the whole vault to the baseline
pnpm og tag before-cleanup   # name a snapshot
```

After `bless`, the review note goes back to **Clean** and new edits are measured
against the new baseline.

## How it's wired

- The vault `example/vaults/demo/` is bind-mounted to `/vault` in the container.
- The git database is kept **outside** the vault at `example/.gitdir/` (mounted
  to `/gitdir`), so nothing git-related ever lives in the synced vault tree.
- The review filename is keyed to a per-replica id (a random UUID) persisted at
  `example/.gitdir/obsidian-guardian/replica-id` — stable across restarts, and
  distinct per git database, with no host probing.
- `_OG/` and `example/.gitdir/` are git-ignored in this repo; only the seed vault
  files are committed.
- The watcher polls (`--poll`) so it reliably sees host edits across the
  bind-mount. It ignores its own `_OG/` writes, so there's no refresh loop.

> The container starts as root and drops to `PUID:PGID` (default `1000:1000`)
> via `gosu`, so review notes written back to the host are owned by you. If your
> user differs, run with `PUID=$(id -u) PGID=$(id -g) docker compose -f
> docker-compose.example.yaml up --build`.
