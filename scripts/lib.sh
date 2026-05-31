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

# --- plugin-in-headless-Obsidian helpers (shared by smoke-plugin + screenshot) ---

OG_PLUGIN_ID="obsidian-guardian"

# Run the Obsidian CLI inside the plugin-test container.
plugin_obs() { docker compose -f "$PLUGIN_COMPOSE_FILE" exec -T obsidian obsidian "$@"; }

plugin_ready() { plugin_obs version >/dev/null 2>&1; }

# Copy the freshly built plugin into the (mounted) test vault.
install_plugin() {
  local dest="$PLUGIN_VAULT/.obsidian/plugins/$OG_PLUGIN_ID"
  mkdir -p "$dest"
  cp "$ROOT"/packages/plugin/dist/main.js "$dest/"
  cp "$ROOT"/packages/plugin/dist/manifest.json "$dest/"
  cp "$ROOT"/packages/plugin/dist/styles.css "$dest/"
}

# Enable + load the plugin once. The container boots in Restricted Mode, so set
# the `enable-plugin-<appId>` localStorage master switch directly, rescan, and
# enable. Idempotent — meant to be retried (e.g. `wait_for 60 plugin_enable_once`)
# because `obs version` can report ready a beat before the plugins API is.
plugin_enable_once() {
  plugin_obs eval "code=(async()=>{localStorage.setItem('enable-plugin-'+app.appId,'true');await app.plugins.loadManifests();await app.plugins.enablePlugin('$OG_PLUGIN_ID');return 'ok'})()" \
    >/dev/null 2>&1 || true
  plugin_obs eval "code=app.plugins.plugins['$OG_PLUGIN_ID'] ? 'LOADED' : 'MISSING'" \
    2>/dev/null | grep -q LOADED
}

# Screenshot the running app to a host path (routed through the mounted vault,
# the only shared dir). Dismisses any first-open trust modal first.
plugin_screenshot() {
  local out="${1:-$ROOT/screenshots/plugin-$(date +%Y%m%d-%H%M%S).png}"
  plugin_obs eval "code=document.querySelectorAll('.modal-close-button').forEach(b=>b.click())" \
    >/dev/null 2>&1 || true
  plugin_obs dev:screenshot "path=/vaults/plugin-test/_OG/__shot.png" >/dev/null 2>&1 || true
  if [ -f "$PLUGIN_VAULT/_OG/__shot.png" ]; then
    mkdir -p "$(dirname "$out")"
    mv "$PLUGIN_VAULT/_OG/__shot.png" "$out"
    return 0
  fi
  return 1
}
