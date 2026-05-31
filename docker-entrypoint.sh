#!/bin/sh
# Entrypoint for the long-running container (and `docker compose run`): as root,
# make the git database writable by the host user, then hand off to the `og`
# shim, which drops privileges and runs the CLI. Set PUID/PGID to your host
# `id -u`/`id -g` so files written back to the mounted vault are owned by you.
set -e

if [ "$(id -u)" = "0" ]; then
  # The git database is ours to own; best-effort so a read-only mount won't fail.
  chown -R "${PUID:-1000}:${PGID:-1000}" "${OG_GIT_DIR:-/gitdir}" 2>/dev/null || true
fi

exec og "$@"
