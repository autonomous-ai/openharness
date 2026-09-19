#!/bin/sh
set -u
if [ -n "${ORCA_BIN:-}" ] && [ -x "$ORCA_BIN" ]; then echo "ok   OrcaSlicer at $ORCA_BIN"; exit 0; fi
if command -v orca-slicer >/dev/null 2>&1 || command -v orcaslicer >/dev/null 2>&1 || [ -x /Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer ]; then echo "ok   OrcaSlicer found"; exit 0; fi
echo "miss OrcaSlicer — install 2.4.2 from https://github.com/OrcaSlicer/OrcaSlicer/releases or set ORCA_BIN"
echo "note PrusaSlicer has a different CLI and is not a substitute"
exit 1
