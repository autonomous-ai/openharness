#!/usr/bin/env bash
# One line per check; exit 0 when this machine can take a Verilog file all the way to a bitstream.
set -u; cd "$(dirname "$0")/.."; bad=0
# The tools and node found the way flow.sh finds them: the package's OSS CAD Suite first.
# shellcheck source=path.sh
. toolchain/path.sh

line() { # line <label> <command...> — ok with the command's first line only when the command succeeds
  local label="$1" out; shift
  if out="$("$@" 2>&1)" && v="${out%%$'\n'*}" && [ -n "$v" ]; then echo "ok   $label — $v"; else echo "miss $label"; bad=1; fi
}

if command -v yosys >/dev/null 2>&1; then line "yosys, the synthesiser" yosys -V; else echo "miss yosys — run toolchain/setup.sh"; bad=1; fi
if command -v nextpnr-ice40 >/dev/null 2>&1; then
  echo "ok   nextpnr-ice40, place and route — $(nextpnr-ice40 --version 2>&1 | head -1)"
else echo "miss nextpnr-ice40 — run toolchain/setup.sh"; bad=1; fi
if command -v icepack >/dev/null 2>&1; then echo "ok   icepack, the bitstream packer (icestorm)"; else echo "miss icepack — run toolchain/setup.sh"; bad=1; fi
if command -v iverilog >/dev/null 2>&1; then line "iverilog, the simulator" iverilog -V; else echo "miss iverilog — run toolchain/setup.sh"; bad=1; fi
if command -v iceprog >/dev/null 2>&1; then echo "ok   iceprog, to flash a board over USB"; else echo "info iceprog not found — synthesis works, flashing a real board does not"; fi

if [ -x node_modules/.bin/netlistsvg ]; then echo "ok   netlistsvg $(node -p "require('netlistsvg/package.json').version" 2>/dev/null), the schematic"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
if harness_node 18 >/dev/null; then echo "ok   node $(node -v) for the viewer"; else harness_node 18; bad=1; fi
# The pane's Board and Chip tabs map package pins to the die with IceStorm's chip database.
chipdb=""
if command -v icepack >/dev/null 2>&1; then
  real="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$(command -v icepack)" 2>/dev/null)"
  # Homebrew's IceStorm keeps it in share/icestorm/chipdb, the OSS CAD Suite in share/icebox.
  for db in share/icestorm/chipdb share/icebox; do
    [ -n "$real" ] && [ -f "$(dirname "$real")/../$db/chipdb-5k.txt" ] && chipdb=yes
  done
fi
if [ -n "$chipdb" ]; then echo "ok   IceStorm chipdb, for the pane's pin maps"; else echo "info IceStorm chipdb not found — the pane falls back to its built-in iCE40UP5K-SG48 pin table"; fi
if command -v python3 >/dev/null 2>&1; then echo "ok   $(python3 --version) for the waveforms and the verdict"; else echo "miss python3"; bad=1; fi

exit $bad
