#!/usr/bin/env bash
# Host CLI smoke test: drive the *built* CLI binary through the full lifecycle
# against a throwaway vault. No docker. Self-contained and self-cleaning — it
# pre-cleans its workspace so a crashed prior run can't affect this one.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

WORK="${TMPDIR:-/tmp}/og-smoke-host"
WATCH_PID=""
cleanup() {
  [ -n "$WATCH_PID" ] && kill "$WATCH_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
rm -rf "$WORK" # pre-clean (in case a previous run was killed before its trap)
trap cleanup EXIT

log "building"
(cd "$ROOT" && pnpm -s build >/dev/null)

BIN="$ROOT/packages/cli/dist/cli.mjs"
VAULT="$WORK/vault"
GITDIR="$WORK/gitdir"
mkdir -p "$VAULT"
og() { node "$BIN" --vault "$VAULT" --git-dir "$GITDIR" "$@"; }

log "onboard establishes a baseline + persists a replica id"
printf 'one\ntwo\n' >"$VAULT/note.md"
assert_ok og onboard
assert_file "$GITDIR/obsidian-guardian/replica-id"

log "status detects an add and a modify"
printf 'one\nTWO\nthree\n' >"$VAULT/note.md"
printf 'a fresh note\n' >"$VAULT/idea.md"
og status >"$WORK/status.txt"
assert_grep 'note.md' "$WORK/status.txt"
assert_grep 'idea.md' "$WORK/status.txt"

log "status --json emits valid JSON"
og status --json >"$WORK/status.json"
assert_ok node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/status.json"

log "refresh writes a rotating snapshot file (accepted:false, pinned snapshot)"
PREFIX="$(signal_prefix "$(cat "$GITDIR/obsidian-guardian/replica-id")")"
og refresh >/dev/null
NOTE="$(ls "$VAULT"/_OG/"${PREFIX}"*.md | head -1)"
assert_file "$NOTE"
assert_grep '\[\[idea\]\]' "$NOTE"
assert_grep '^accepted: false' "$NOTE"
assert_grep '^snapshot: [0-9a-f]{40}$' "$NOTE"
assert_grep '^seq: [0-9]+$' "$NOTE"

log "revert restores a single file to the baseline"
og revert note.md >/dev/null
[ "$(cat "$VAULT/note.md")" = "$(printf 'one\ntwo\n')" ] || fail "revert did not restore note.md"

log "bless advances the baseline and clears pending"
og bless >/dev/null
og status >"$WORK/status2.txt"
assert_grep '^clean' "$WORK/status2.txt"
# bless changes no vault files, so it must write a fresh (clean) snapshot itself
grep -lq 'Nothing pending' "$VAULT"/_OG/"${PREFIX}"*.md ||
  fail "no clean snapshot file after bless"

log "watch performs a file-controlled bless on an accepted: true signal"
VAULT3="$WORK/vault3"
GITDIR3="$WORK/gitdir3"
mkdir -p "$VAULT3"
printf 'base\n' >"$VAULT3/note.md"
node "$BIN" --vault "$VAULT3" --git-dir "$GITDIR3" onboard >/dev/null
PREFIX3="$(signal_prefix "$(cat "$GITDIR3/obsidian-guardian/replica-id")")"
node "$BIN" --vault "$VAULT3" --git-dir "$GITDIR3" --poll --debounce 100 watch \
  >/dev/null 2>&1 &
WATCH_PID=$!
# an edit produces a signal file pinned to the new snapshot
printf 'an agent edit\n' >"$VAULT3/agent.md"
agent_signal() { grep -lqE '\[\[agent\]\]' "$VAULT3"/_OG/"${PREFIX3}"*.md 2>/dev/null; }
wait_for 15 agent_signal || fail "watch did not write an accepted:false signal for the edit"
SIG="$(grep -lE '\[\[agent\]\]' "$VAULT3"/_OG/"${PREFIX3}"*.md | head -1)"
assert_grep '^accepted: false' "$SIG"
# simulate the mobile edit syncing back: toggle the checkbox on
sed -i 's/^accepted: false/accepted: true/' "$SIG"
# the watcher blesses exactly that snapshot → status goes clean
status_clean() { node "$BIN" --vault "$VAULT3" --git-dir "$GITDIR3" status | grep -q '^clean'; }
wait_for 15 status_clean || fail "accepted: true did not advance the baseline"
kill "$WATCH_PID" 2>/dev/null || true
WATCH_PID=""

log "guard: a git-dir inside the vault is rejected"
assert_fail node "$BIN" --vault "$VAULT" --git-dir "$VAULT/.inside" status

log "the --replica-id flag overrides the filename deterministically"
VAULT2="$WORK/vault2"
GITDIR2="$WORK/gitdir2"
mkdir -p "$VAULT2"
printf 'x\n' >"$VAULT2/n.md"
node "$BIN" --vault "$VAULT2" --git-dir "$GITDIR2" --replica-id fixed onboard >/dev/null
node "$BIN" --vault "$VAULT2" --git-dir "$GITDIR2" --replica-id fixed refresh >/dev/null
ls "$VAULT2"/_OG/"$(signal_prefix fixed)"*.md >/dev/null 2>&1 ||
  fail "no snapshot file for the fixed replica id"

pass "SMOKE PASS"
