#!/usr/bin/env bash
# Container smoke test: build the image, run the watcher against the example
# vault via the real compose file, edit a file, and assert the review note
# updates — owned by the host user. Pre-cleans the demo so a crashed prior run
# can't affect this one; resets it again on exit. Needs the docker daemon.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

command -v docker >/dev/null 2>&1 || fail "docker not found (test:docker needs the daemon)"

cd "$ROOT"
PUID="$(id -u)"
PGID="$(id -g)"
export PUID PGID

trap reset_demo EXIT
log "pre-clean: reset the demo to a pristine state"
reset_demo

log "build the image and start the watcher"
docker compose -f "$COMPOSE_FILE" up -d --build >/dev/null

log "wait for the watcher's initial refresh"
note_written() { ls "$DEMO_VAULT"/_OG/changes-*.md >/dev/null 2>&1; }
wait_for 90 note_written || fail "review note was not written within 90s"
NOTE="$(ls "$DEMO_VAULT"/_OG/changes-*.md | head -1)"
pass "review note written: ${NOTE#"$ROOT"/}"

assert_file "$ROOT/example/.gitdir/obsidian-guardian/replica-id"
pass "replica id persisted in the gitDir"

log "edit a file → the watcher reflects it"
printf '\n- docker smoke marker\n' >>"$DEMO_VAULT/Ideas.md"
edit_reflected() { grep -Eq '\[\[Ideas\]\]' "$NOTE"; }
wait_for 30 edit_reflected || fail "edit not reflected in the review note within 30s"
pass "edit reflected in the review note"

log "the review note is written back owned by the host user (PUID drop)"
owner="$(stat -c %u "$NOTE")"
[ "$owner" = "$PUID" ] || fail "review note owned by uid $owner, expected $PUID"
pass "owned by uid $PUID"

log "exec og bless via the shim → runs as host user and refreshes the note"
docker compose -f "$COMPOSE_FILE" exec -T guardian og bless >/dev/null
blessed() { grep -Eq 'status: blessed' "$NOTE"; }
wait_for 30 blessed || fail "note not refreshed to blessed after 'exec og bless'"
owner2="$(stat -c %u "$NOTE")"
[ "$owner2" = "$PUID" ] || fail "note owned by uid $owner2 after exec bless, expected $PUID"
pass "exec og bless ran as uid $PUID and refreshed the note to clean"

pass "DOCKER SMOKE PASS"
