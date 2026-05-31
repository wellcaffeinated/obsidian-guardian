#!/bin/sh
# Drop privileges to the host user (PUID/PGID) the linux-server way: start as
# root, make the git database writable by that user, then exec the CLI as them
# via gosu. Set PUID/PGID to your host `id -u`/`id -g` so files written back to
# the mounted vault are owned by you, not root.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CLI="/app/packages/cli/dist/cli.mjs"

if [ "$(id -u)" = "0" ]; then
  # The git database is ours to own; best-effort so a read-only mount won't fail.
  chown -R "${PUID}:${PGID}" "${OG_GIT_DIR:-/gitdir}" 2>/dev/null || true
  exec gosu "${PUID}:${PGID}" node "${CLI}" "$@"
fi

# Already non-root (e.g. an explicit compose `user:` override) — just run.
exec node "${CLI}" "$@"
