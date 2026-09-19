#!/bin/sh
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
fail=0
if [ -n "${GODOT_BIN:-}" ] && [ -x "$GODOT_BIN" ]; then echo "ok   godot at $GODOT_BIN"
elif command -v godot >/dev/null 2>&1; then echo "ok   godot on PATH ($(command -v godot))"
elif [ -x /Applications/Godot.app/Contents/MacOS/Godot ]; then echo "ok   godot at /Applications/Godot.app/Contents/MacOS/Godot"
else echo "miss godot — install Godot 4 and re-run setup"; fail=1; fi
[ -d "$dsh/skills/godot" ] && echo "ok   godot skill" || echo "warn godot skill missing"
exit $fail
