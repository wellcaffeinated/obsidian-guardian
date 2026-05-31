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

log "review is opt-in per machine: assert nothing is written before activation"
note_written() { ls "$PLUGIN_VAULT"/_OG/changes-*.md >/dev/null 2>&1; }
sleep 3
if note_written; then fail "plugin wrote a review note before explicit activation"; fi
pass "plugin stayed inactive (no review note) until activated"

log "activate review on this machine (explicit per-machine opt-in)"
obs eval "code=app.commands.executeCommandById('obsidian-guardian:activate')" >/dev/null 2>&1 || true

log "wait for the engine's initial review note (onboard + refresh after activation)"
wait_for 30 note_written || fail "review note was not written within 30s"
NOTE="$(ls "$PLUGIN_VAULT"/_OG/changes-*.md | head -1)"
pass "review note written: ${NOTE#"$ROOT"/}"

log "wait for the first-activation auto-bless to settle the baseline"
sleep 5   # the plugin advances the baseline ~3s after a fresh onboard
note_clean() { grep -Eq 'status: blessed|Nothing pending' "$NOTE"; }
wait_for 20 note_clean || fail "review did not settle to a clean baseline after first activation"
pass "first activation settled to a clean baseline (no .obsidian self-noise)"

log "open the panel and screenshot it"
obs eval "code=app.commands.executeCommandById('obsidian-guardian:open-review-panel')" >/dev/null 2>&1 || true
sleep 1
obs dev:screenshot path=/vaults/plugin-test/_OG/panel.png >/dev/null 2>&1 || true
if [ -f "$PLUGIN_VAULT/_OG/panel.png" ]; then
  pass "panel screenshot captured"
else
  log "screenshot not captured (non-fatal)"
fi

log "edit a note → the review reflects it"
printf '\n- plugin smoke marker\n' >>"$PLUGIN_VAULT/Ideas.md"
edit_reflected() { grep -Eq 'Ideas' "$NOTE"; }
wait_for 30 edit_reflected || fail "edit not reflected in the review note within 30s"
pass "edit reflected in the review note"

log "bless via the plugin command → review goes clean"
obs eval "code=app.commands.executeCommandById('obsidian-guardian:bless')" >/dev/null 2>&1 || true
blessed() { grep -Eq 'status: blessed|Nothing pending' "$NOTE"; }
wait_for 30 blessed || fail "review note not refreshed to blessed after bless"
pass "bless cleared the review"

pass "PLUGIN SMOKE PASS"
