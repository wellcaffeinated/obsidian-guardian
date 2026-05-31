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

# Run the Obsidian CLI inside the container.
obs() { docker compose -f "$PLUGIN_COMPOSE_FILE" exec -T obsidian obsidian "$@"; }

trap reset_plugin EXIT
log "pre-clean: reset the plugin-test vault"
reset_plugin

log "build the plugin and copy it into the vault"
pnpm --filter @obsidian-guardian/plugin build >/dev/null
mkdir -p "$PLUGIN_DIR"
cp "$ROOT"/packages/plugin/dist/main.js "$PLUGIN_DIR/"
cp "$ROOT"/packages/plugin/dist/manifest.json "$PLUGIN_DIR/"
cp "$ROOT"/packages/plugin/dist/styles.css "$PLUGIN_DIR/"
assert_file "$PLUGIN_DIR/main.js"

log "start headless Obsidian"
docker compose -f "$PLUGIN_COMPOSE_FILE" up -d >/dev/null

log "wait for Obsidian to come up"
obsidian_ready() { obs version >/dev/null 2>&1; }
wait_for 180 obsidian_ready || fail "Obsidian did not become ready within 180s"
pass "Obsidian is up"

# The container defaults to Restricted Mode (community plugins off). The master
# switch is the `enable-plugin-<appId>` localStorage flag; set it directly (so
# the trust dialog doesn't gate us), rescan manifests, and load our plugin.
# `obs version` can succeed a moment before the plugins API is fully ready, so
# re-run the enable each poll until the plugin actually registers (idempotent).
log "enable community plugins and load obsidian-guardian"
enable_and_check() {
  obs eval "code=(async()=>{localStorage.setItem('enable-plugin-'+app.appId,'true');await app.plugins.loadManifests();await app.plugins.enablePlugin('obsidian-guardian');return 'ok'})()" >/dev/null 2>&1 || true
  obs eval "code=app.plugins.plugins['obsidian-guardian'] ? 'LOADED' : 'MISSING'" \
    2>/dev/null | grep -q LOADED
}
if ! wait_for 60 enable_and_check; then
  log "plugin did not load — diagnostics follow"
  obs dev:errors 2>&1 || true
  fail "plugin obsidian-guardian did not load"
fi
pass "plugin loaded"

log "wait for the engine's initial review note (onboard + refresh on load)"
note_written() { ls "$PLUGIN_VAULT"/_OG/changes-*.md >/dev/null 2>&1; }
wait_for 30 note_written || fail "review note was not written within 30s"
NOTE="$(ls "$PLUGIN_VAULT"/_OG/changes-*.md | head -1)"
pass "review note written: ${NOTE#"$ROOT"/}"

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
