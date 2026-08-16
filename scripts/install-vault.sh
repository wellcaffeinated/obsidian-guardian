#!/usr/bin/env bash
# Build the plugin and drop it into a vault you manage yourself, then reload it
# in the running app. The fast manual-iteration loop — the rigorous one is
# `pnpm test:plugin`, which drives a throwaway headless container and asserts
# behaviour. This script asserts nothing; it just gets a build in front of you.
#
#   pnpm install:vault "/path/to/vault"     # explicit path (always unambiguous)
#   pnpm install:vault "Main Vault"         # vault name, resolved via the CLI
#   OG_VAULT="/path/to/vault" pnpm install:vault
#
# It writes into a real vault, so it refuses anything that doesn't look like
# one, and it never touches notes — only
# <vault>/<configDir>/plugins/obsidian-guardian/.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PLUGIN_ID="obsidian-guardian"
CONFIG_DIR="${OG_CONFIG_DIR:-.obsidian}"

# Skipped rather than failed on CI: this is a developer convenience, and no CI
# job has a vault to install into.
if [ -n "${CI:-}" ]; then
  log "CI detected — nothing to install into, skipping"
  exit 0
fi

TARGET="${1:-${OG_VAULT:-}}"
[ -n "$TARGET" ] || fail "usage: pnpm install:vault <vault-path-or-name> (or set OG_VAULT)"

# Set only when the CLI knows this vault by name. Every CLI call below is scoped
# to it, because a bare call goes to whichever vault the app happens to have
# open — which may not be the one we just installed into.
VAULT_NAME=""

# A name (no slash, not a local dir) is resolved through the Obsidian CLI, which
# lists "<name>\t<path>". Note the paths it reports are the app's own — if
# Obsidian runs in a container, they are container paths, so pass an explicit
# path when this machine's view of the vault differs.
if [ ! -d "$TARGET" ] && [ "${TARGET#*/}" = "$TARGET" ]; then
  command -v obsidian >/dev/null 2>&1 ||
    fail "'$TARGET' is not a directory and the obsidian CLI isn't on PATH to resolve it as a vault name"
  RESOLVED="$(obsidian vaults verbose 2>/dev/null | awk -F'\t' -v n="$TARGET" '$1 == n {print $2; exit}')"
  [ -n "$RESOLVED" ] || fail "no vault named '$TARGET' (try: obsidian vaults)"
  log "resolved vault '$TARGET' → $RESOLVED"
  VAULT_NAME="$TARGET"
  TARGET="$RESOLVED"
elif command -v obsidian >/dev/null 2>&1; then
  # Given a path: reverse-lookup its name so the reload can be scoped to it.
  ABS="$(cd "$TARGET" 2>/dev/null && pwd || true)"
  [ -n "$ABS" ] &&
    VAULT_NAME="$(obsidian vaults verbose 2>/dev/null | awk -F'\t' -v p="$ABS" '$2 == p {print $1; exit}')"
fi

[ -d "$TARGET" ] || fail "not a directory: $TARGET"
[ -d "$TARGET/$CONFIG_DIR" ] ||
  fail "no $CONFIG_DIR/ in $TARGET — that isn't a vault (override the name with OG_CONFIG_DIR)"

DEST="$TARGET/$CONFIG_DIR/plugins/$PLUGIN_ID"

log "build the plugin"
pnpm --filter @obsidian-guardian/plugin build >/dev/null

SRC="$ROOT/packages/plugin/dist"
for f in main.js manifest.json styles.css; do assert_file "$SRC/$f"; done

log "install into $DEST"
mkdir -p "$DEST"
cp "$SRC/main.js" "$SRC/manifest.json" "$SRC/styles.css" "$DEST/"

# Only meaningful if this machine's Obsidian is the one holding that vault, and
# only ever scoped to that vault by name (`vault=` must precede the subcommand —
# after it, the CLI ignores it and silently targets the open vault instead). A
# failure is not fatal: the files are in place, reload by hand.
if [ -n "$VAULT_NAME" ] && command -v obsidian >/dev/null 2>&1; then
  if obsidian vault="$VAULT_NAME" plugin:reload id="$PLUGIN_ID" >/dev/null 2>&1; then
    pass "installed and reloaded in '$VAULT_NAME'"
    exit 0
  fi
  log "CLI reload didn't take (vault not open, or the plugin isn't enabled yet)"
fi

pass "installed — enable or reload $PLUGIN_ID in Obsidian to pick it up"
