#!/bin/sh
# Exit 0 when this machine can run the harness. Print one line per check; Harness shows them.
set -u
fail=0
if [ -n "${FREECAD_BIN:-}" ] && [ -x "$FREECAD_BIN" ]; then
  echo "ok   freecadcmd at $FREECAD_BIN"
elif command -v freecadcmd >/dev/null 2>&1; then
  echo "ok   freecadcmd on PATH ($(command -v freecadcmd))"
elif command -v FreeCADCmd >/dev/null 2>&1; then
  echo "ok   freecadcmd on PATH ($(command -v FreeCADCmd))"
elif [ -x "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd" ]; then
  echo "ok   freecadcmd at /Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd"
elif [ -x "/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd" ]; then
  echo "ok   FreeCADCmd at /Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd"
else
  echo "miss freecadcmd — run toolchain/setup.sh or install from https://freecad.org"
  fail=1
fi
[ -d "$(dirname "$0")/../skills/freecad" ] && echo "ok   freecad skill" || echo "warn freecad skill missing"
exit $fail
