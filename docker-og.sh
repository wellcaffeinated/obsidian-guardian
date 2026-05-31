#!/bin/sh
# `og` on the image PATH: run the Obsidian Guardian CLI as the host user
# (PUID/PGID) when invoked as root — so `docker compose exec guardian og <cmd>`
# writes files owned by you, not root — otherwise run it directly. Mirrors the
# entrypoint's privilege drop so management commands are a short one-liner.
CLI=/app/packages/cli/dist/cli.mjs
if [ "$(id -u)" = "0" ]; then
  exec gosu "${PUID:-1000}:${PGID:-1000}" node "$CLI" "$@"
fi
exec node "$CLI" "$@"
