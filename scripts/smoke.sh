#!/usr/bin/env bash
# Host CLI smoke test: drive the *built* CLI binary through the full lifecycle
# against a throwaway vault. No docker. Self-contained and self-cleaning — it
# pre-cleans its workspace so a crashed prior run can't affect this one.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

WORK="${TMPDIR:-/tmp}/og-smoke-host"
cleanup() { rm -rf "$WORK"; }
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

log "refresh writes the review note (name derived from the persisted id)"
og refresh >/dev/null
NOTE="$VAULT/_OG/$(review_name "$(cat "$GITDIR/obsidian-guardian/replica-id")")"
assert_file "$NOTE"
assert_grep '\[\[idea\]\]' "$NOTE"

log "revert restores a single file to the baseline"
og revert note.md >/dev/null
[ "$(cat "$VAULT/note.md")" = "$(printf 'one\ntwo\n')" ] || fail "revert did not restore note.md"

log "bless advances the baseline and clears pending"
og bless >/dev/null
og status >"$WORK/status2.txt"
assert_grep '^clean' "$WORK/status2.txt"

log "guard: a git-dir inside the vault is rejected"
assert_fail node "$BIN" --vault "$VAULT" --git-dir "$VAULT/.inside" status

log "the --replica-id flag overrides the filename deterministically"
VAULT2="$WORK/vault2"
GITDIR2="$WORK/gitdir2"
mkdir -p "$VAULT2"
printf 'x\n' >"$VAULT2/n.md"
node "$BIN" --vault "$VAULT2" --git-dir "$GITDIR2" --replica-id fixed onboard >/dev/null
node "$BIN" --vault "$VAULT2" --git-dir "$GITDIR2" --replica-id fixed refresh >/dev/null
assert_file "$VAULT2/_OG/$(review_name fixed)"

pass "SMOKE PASS"
