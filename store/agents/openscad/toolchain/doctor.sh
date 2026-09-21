#!/bin/sh
# Exit 0 when this machine can run the harness. Print one line per check; Harness shows them.
set -u
fail=0
if [ -n "${OPENSCAD_BIN:-}" ] && [ -x "$OPENSCAD_BIN" ]; then
  echo "ok   openscad at $OPENSCAD_BIN"
elif command -v openscad >/dev/null 2>&1; then
  echo "ok   openscad on PATH ($(command -v openscad))"
elif [ -x "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD" ]; then
  echo "ok   openscad at /Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"
else
  echo "miss openscad — run toolchain/setup.sh or install from https://openscad.org"
  fail=1
fi
[ -d "$(dirname "$0")/../skills/openscad" ] && echo "ok   openscad skill" || echo "warn openscad skill missing"
exit $fail
