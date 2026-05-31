#!/usr/bin/env bash
# Shared helpers for the smoke scripts: logging, assertions, polling, and the
# demo reset used for both pre-clean and teardown.

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$_LIB_DIR/.." && pwd)"
COMPOSE_FILE="$ROOT/docker-compose.example.yaml"
DEMO_VAULT="$ROOT/example/vaults/demo"
ENGINE_CJS="$ROOT/packages/engine/dist/index.cjs"
PLUGIN_COMPOSE_FILE="$ROOT/docker-compose.plugin-test.yaml"
PLUGIN_VAULT="$ROOT/example/plugin-vault"

log() { printf '\033[1;34m• %s\033[0m\n' "$*"; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
fail() {
  printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

assert_ok() { "$@" >/dev/null 2>&1 || fail "expected success: $*"; }
assert_fail() { if "$@" >/dev/null 2>&1; then fail "expected failure: $*"; fi; }
assert_file() { [ -f "$1" ] || fail "missing file: $1"; }
assert_grep() { grep -Eq "$1" "$2" || fail "pattern not found in $2: $1"; }

# wait_for <seconds> <command...> — poll until the command succeeds or times out.
wait_for() {
  local timeout="$1"
  shift
  local deadline=$(($(date +%s) + timeout))
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 1
  done
}

# The review-note filename the engine would generate for a given replica id.
review_name() {
  node -e 'const{reviewNoteName}=require(process.argv[1]);process.stdout.write(reviewNoteName(process.argv[2]))' \
    "$ENGINE_CJS" "$1"
}

# Reset the demo to a pristine, committed state: stop the container, drop the
# review output and the git-database contents, restore the seed vault files.
# Used as both the pre-clean and the teardown, so a crashed run self-heals.
reset_demo() {
  docker compose -f "$COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DEMO_VAULT/_OG"
  find "$ROOT/example/.gitdir" -mindepth 1 ! -name .gitkeep -exec rm -rf {} + \
    2>/dev/null || true
  git -C "$ROOT" restore -- example/vaults/demo >/dev/null 2>&1 || true
}

# Reset the plugin-test vault: stop the obsidian container, drop the review
# output, and discard the workspace/app state Obsidian writes into .obsidian.
# Both pre-clean and teardown, so a crashed run self-heals.
reset_plugin() {
  docker compose -f "$PLUGIN_COMPOSE_FILE" down --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$PLUGIN_VAULT/_OG"
  git -C "$ROOT" restore -- example/plugin-vault >/dev/null 2>&1 || true
  git -C "$ROOT" clean -fdq -- example/plugin-vault >/dev/null 2>&1 || true
}
