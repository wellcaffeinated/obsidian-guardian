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

# Find this replica's snapshot file whose content matches a pattern.
find_signal() { grep -lE "$1" "$DEMO_VAULT"/_OG/changes-*.md 2>/dev/null | head -1; }

log "wait for the watcher's initial snapshot file"
note_written() { ls "$DEMO_VAULT"/_OG/changes-*.md >/dev/null 2>&1; }
wait_for 90 note_written || fail "snapshot file was not written within 90s"
pass "initial snapshot file written"

assert_file "$ROOT/example/.gitdir/obsidian-guardian/replica-id"
pass "replica id persisted in the gitDir"

log "edit a file → the watcher writes a pinned, accepted:false signal file"
printf '\n- docker smoke marker\n' >>"$DEMO_VAULT/Ideas.md"
edit_reflected() { [ -n "$(find_signal '\[\[Ideas\]\]')" ]; }
wait_for 30 edit_reflected || fail "edit not reflected in a snapshot file within 30s"
SIG="$(find_signal '\[\[Ideas\]\]')"
assert_grep '^accepted: false' "$SIG"
assert_grep '^snapshot: [0-9a-f]{40}$' "$SIG"
pass "signal file written: ${SIG#"$ROOT"/}"

log "the signal file is written back owned by the host user (PUID drop)"
owner="$(stat -c %u "$SIG")"
[ "$owner" = "$PUID" ] || fail "signal file owned by uid $owner, expected $PUID"
pass "owned by uid $PUID"

log "toggle accepted: true (simulating a synced mobile edit) → file-controlled bless"
sed -i 's/^accepted: false$/accepted: true/' "$SIG"
status_clean() {
  docker compose -f "$COMPOSE_FILE" exec -T guardian og status 2>/dev/null |
    grep -q '^clean'
}
wait_for 30 status_clean || fail "accepted: true did not advance the baseline within 30s"
# the watcher emits a fresh clean snapshot file, host-owned
clean_written() { [ -n "$(find_signal 'Nothing pending')" ]; }
wait_for 10 clean_written || fail "no clean snapshot file after the accepted bless"
CLEAN="$(find_signal 'Nothing pending')"
owner2="$(stat -c %u "$CLEAN")"
[ "$owner2" = "$PUID" ] || fail "clean file owned by uid $owner2, expected $PUID"
pass "accepted: true blessed the pinned snapshot; baseline advanced (host-owned)"

log "exec og bless via the shim still works (runs as host user)"
printf '\n- second marker\n' >>"$DEMO_VAULT/Ideas.md"
wait_for 30 'edit_reflected' || fail "second edit not reflected"
docker compose -f "$COMPOSE_FILE" exec -T guardian og bless >/dev/null
wait_for 30 status_clean || fail "exec og bless did not clear pending"
pass "exec og bless ran as host user and cleared pending"

pass "DOCKER SMOKE PASS"
