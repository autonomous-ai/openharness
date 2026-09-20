#!/bin/sh
# Install/verify FreeCAD for this harness. cwd = the package install dir.
# FreeCAD is a desktop app with a headless CLI (FreeCADCmd); detect an existing
# install, otherwise provide an explicit installation instruction.
set -u

dsh="${HARNESS_DSH_DIR:-$PWD}"

find_freecad() {
  [ -z "${FREECAD_BIN:-}" ] || { [ -x "$FREECAD_BIN" ] && { echo "$FREECAD_BIN"; return 0; }; }
  command -v freecadcmd 2>/dev/null && return 0
  command -v FreeCADCmd 2>/dev/null && return 0
  [ -x "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd" ] && { echo "/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd"; return 0; }
  [ -x "/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd" ] && { echo "/Applications/FreeCAD.app/Contents/MacOS/FreeCADCmd"; return 0; }
  return 1
}

if bin=$(find_freecad); then
  echo "ok   freecad at $bin"
  ln -sf "$bin" "$dsh/toolchain/freecad-cli" 2>/dev/null || true
  exit 0
fi

echo "miss freecadcmd — install FreeCAD from https://freecad.org or set FREECAD_BIN, then re-run setup."
exit 1
