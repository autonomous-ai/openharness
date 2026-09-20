#!/bin/sh
# Install/verify OpenSCAD for this harness. cwd = the package install dir.
# OpenSCAD is a desktop CLI; we detect an existing install, otherwise provide an explicit installation instruction.
set -u

dsh="${HARNESS_DSH_DIR:-$PWD}"

find_openscad() {
  [ -z "${OPENSCAD_BIN:-}" ] || { [ -x "$OPENSCAD_BIN" ] && { echo "$OPENSCAD_BIN"; return 0; }; }
  command -v openscad 2>/dev/null && return 0
  [ -x "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD" ] && { echo "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"; return 0; }
  return 1
}

if bin=$(find_openscad); then
  echo "ok   openscad at $bin"
  ln -sf "$bin" "$dsh/toolchain/openscad-cli" 2>/dev/null || true
  exit 0
fi

echo "miss openscad — install OpenSCAD from https://openscad.org or set OPENSCAD_BIN, then re-run setup."
exit 1
