#!/usr/bin/env bash
# Capture a screenshot of the plugin's review panel running in headless Obsidian.
# Brings the container up (building + loading the plugin) if it isn't already,
# otherwise rebuilds + hot-reloads so the shot reflects the latest code. Leaves
# the container RUNNING so repeated shots are fast (stop with
# `docker compose -f docker-compose.plugin-test.yaml down`).
#
# Usage: bash scripts/screenshot-plugin.sh [output.png]   (default: screenshots/plugin.png)
# Needs the docker daemon.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

command -v docker >/dev/null 2>&1 || fail "docker not found"

OUT="${1:-$ROOT/screenshots/plugin-$(date +%Y%m%d-%H%M%S).png}"
export PUID="$(id -u)" PGID="$(id -g)"

log "build the plugin"
pnpm --filter @obsidian-guardian/plugin build >/dev/null

if docker compose -f "$PLUGIN_COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -q obsidian; then
  log "container running — reinstall + hot-reload"
  install_plugin
  plugin_obs plugin:reload "id=$OG_PLUGIN_ID" >/dev/null 2>&1 || true
else
  log "start headless Obsidian + load the plugin"
  install_plugin
  docker compose -f "$PLUGIN_COMPOSE_FILE" up -d >/dev/null
  wait_for 180 plugin_ready || fail "Obsidian did not become ready within 180s"
  wait_for 60 plugin_enable_once || { plugin_obs dev:errors 2>&1 || true; fail "plugin did not load"; }
fi
pass "plugin loaded"

log "open the review panel and refresh"
plugin_obs eval "code=app.commands.executeCommandById('$OG_PLUGIN_ID:open-review-panel')" >/dev/null 2>&1 || true
plugin_obs eval "code=app.commands.executeCommandById('$OG_PLUGIN_ID:refresh')" >/dev/null 2>&1 || true
sleep 2

if plugin_screenshot "$OUT"; then
  pass "screenshot saved to ${OUT#"$ROOT"/}"
else
  fail "screenshot was not captured"
fi
