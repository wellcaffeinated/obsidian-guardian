#!/usr/bin/env bash
# Build + load the Guardian plugin in headless Obsidian and screenshot the review
# panel rendered as a FULL-WINDOW OVERLAY.
#
# Why the overlay: Obsidian 1.7+ defers background-tab views, so a panel opened
# by the harness stays unmounted (blank shot) even though it renders correctly.
# We read the view's already-rendered `contentEl` and mount its markup as a fixed
# overlay in the visible document (same stylesheet), then shoot that. The real
# plugin mounts fine in actual Obsidian; this is a Phase-G design-iteration tool.
# See memory: headless-screenshot-deferred-view.
#
# Usage:  bash scripts/shot-stub.sh [out.png]   (default screenshots/stub-<ts>.png)
# Reuses the running plugin-test container if up (fast hot-reload), else boots it.
# Needs the docker daemon.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

command -v docker >/dev/null 2>&1 || fail "docker not found"

OUT="${1:-$ROOT/screenshots/stub-$(date +%Y%m%d-%H%M%S).png}"
export PUID="$(id -u)" PGID="$(id -g)"
VIEW_TYPE="$OG_PLUGIN_ID-review"

log "build the plugin"
pnpm --filter @obsidian-guardian/plugin build >/dev/null
install_plugin

if docker compose -f "$PLUGIN_COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -q obsidian; then
  log "container running — hot-reload plugin"
  plugin_obs eval "code=app.plugins.disablePlugin('$OG_PLUGIN_ID').then(()=>app.plugins.enablePlugin('$OG_PLUGIN_ID')).then(()=>'ok')" >/dev/null 2>&1 || true
else
  log "start headless Obsidian + load the plugin"
  docker compose -f "$PLUGIN_COMPOSE_FILE" up -d >/dev/null
  wait_for 200 plugin_ready || fail "Obsidian did not become ready"
  wait_for 60 plugin_enable_once || fail "plugin did not load"
fi
sleep 2

log "open panel + render as overlay"
plugin_obs eval "code=app.commands.executeCommandById('$OG_PLUGIN_ID:open-review-panel')" >/dev/null 2>&1 || true
sleep 2
plugin_obs eval "code=(()=>{let lv=null;app.workspace.iterateAllLeaves(l=>{if(l.view&&l.view.getViewType&&l.view.getViewType()==='$VIEW_TYPE')lv=l});if(!lv)return 'no-leaf';lv.view.update&&lv.view.update();const src=lv.view.contentEl;let ov=document.getElementById('og-overlay');if(ov)ov.remove();ov=document.createElement('div');ov.id='og-overlay';ov.style.cssText='position:fixed;inset:0;z-index:99999;overflow:auto;padding:8px';ov.style.background=getComputedStyle(document.body).getPropertyValue('--background-primary')||'#fff';const inner=document.createElement('div');inner.className='view-content og';inner.innerHTML=src.innerHTML;ov.appendChild(inner);document.body.appendChild(ov);return 'ok'})()" >/dev/null 2>&1 || true
sleep 1

if plugin_screenshot "$OUT"; then
  pass "screenshot saved to ${OUT#"$ROOT"/}"
else
  fail "screenshot was not captured"
fi
