#!/usr/bin/env bash
# Plugin smoke test: build the plugin, load it inside a headless Obsidian
# (wellcaffeinated/obsidian-headless-container), and drive the dev loop over
# `docker exec` — enable + load it, assert it loads with no errors, screenshot
# the panel, edit a note and watch the review update, then bless and watch it
# clear.
#
# NEVER run against your real Obsidian — this is a throwaway container + vault.
# Pre-cleans so a crashed prior run can't poison this one; resets again on exit.
# Needs the docker daemon (and pulls the obsidian image on first run).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

command -v docker >/dev/null 2>&1 || fail "docker not found (test:plugin needs the daemon)"

cd "$ROOT"
PUID="$(id -u)"
PGID="$(id -g)"
export PUID PGID

PLUGIN_DIR="$PLUGIN_VAULT/.obsidian/plugins/obsidian-guardian"

# Run the Obsidian CLI inside the container (shared helper from lib.sh).
obs() { plugin_obs "$@"; }

trap reset_plugin EXIT
log "pre-clean: reset the plugin-test vault"
reset_plugin

log "build the plugin and copy it into the vault"
pnpm --filter @obsidian-guardian/plugin build >/dev/null
install_plugin
assert_file "$PLUGIN_DIR/main.js"

log "start headless Obsidian"
docker compose -f "$PLUGIN_COMPOSE_FILE" up -d >/dev/null

log "wait for Obsidian to come up"
wait_for 180 plugin_ready || fail "Obsidian did not become ready within 180s"
pass "Obsidian is up"

# The container defaults to Restricted Mode; plugin_enable_once (lib.sh) flips the
# localStorage master switch + enables the plugin, retried until it registers.
log "enable community plugins and load obsidian-guardian"
if ! wait_for 60 plugin_enable_once; then
  log "plugin did not load — diagnostics follow"
  obs dev:errors 2>&1 || true
  fail "plugin obsidian-guardian did not load"
fi
pass "plugin loaded"

# New p2p design: the plugin writes nothing into the vault except the synced
# signal folder `_OG/sync/` (device-<id>.json + bless-<id>.json), and only after
# explicit per-device activation. There is no review note — the panel is the UI.
SYNC_DIR="$PLUGIN_VAULT/_OG/sync"

log "review is opt-in per device: assert no signal is published before activation"
device_published() { ls "$SYNC_DIR"/device-*.json >/dev/null 2>&1; }
sleep 3
if device_published; then fail "plugin published a device signal before explicit activation"; fi
pass "plugin stayed inactive (no signal files) until activated"

log "activate review on this device (explicit per-device opt-in)"
obs eval "code=app.commands.executeCommandById('obsidian-guardian:activate')" >/dev/null 2>&1 || true

log "wait for the engine to publish this device's state (onboard + recover)"
wait_for 30 device_published || fail "device signal not published within 30s"
pass "device signal published: _OG/sync/device-*.json"

log "wait for the first-activation auto-bless to settle the baseline"
sleep 6   # the plugin advances the baseline ~3s after a fresh onboard
bless_published() { ls "$SYNC_DIR"/bless-*.json >/dev/null 2>&1; }
wait_for 20 bless_published || fail "no bless record published after first activation"
pass "first activation published a bless record"

log "open the panel and screenshot it"
obs eval "code=app.commands.executeCommandById('obsidian-guardian:open-review-panel')" >/dev/null 2>&1 || true
sleep 1
plugin_screenshot "$ROOT/screenshots/plugin-smoke.png" \
  && pass "panel screenshot captured" \
  || log "screenshot not captured (non-fatal)"

log "edit a note → bless it → the bless manifest names the edited file"
printf '\n- plugin smoke marker\n' >>"$PLUGIN_VAULT/Ideas.md"
sleep 1
obs eval "code=app.commands.executeCommandById('obsidian-guardian:bless')" >/dev/null 2>&1 || true
edit_blessed() { grep -q 'Ideas.md' "$SYNC_DIR"/bless-*.json 2>/dev/null; }
wait_for 30 edit_blessed || fail "edited file not present in the bless manifest within 30s"
pass "edit captured in the bless manifest"

pass "PLUGIN SMOKE PASS"
