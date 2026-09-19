#!/bin/sh
# Install/verify Godot 4 for this harness. cwd = the package install dir.
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
find_godot() { if [ -n "${GODOT_BIN:-}" ]; then [ -x "$GODOT_BIN" ] && { echo "$GODOT_BIN"; return 0; }; return 1; fi; command -v godot 2>/dev/null && return 0; [ -x /Applications/Godot.app/Contents/MacOS/Godot ] && { echo /Applications/Godot.app/Contents/MacOS/Godot; return 0; }; return 1; }
if bin=$(find_godot); then
  echo "ok   godot at $bin"
  exit 0
fi
echo "miss godot — install Godot 4 from https://godotengine.org (macOS app or CLI on PATH) and re-run setup."
echo "      Web export also needs the matching HTML5 export templates (Editor → Export)."
exit 1
