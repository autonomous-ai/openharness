#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: a Node and a Python of the package's own, KiCad
# itself (toolchain/kicad.sh — the official build, vendored here, never the machine's), then fetch
# Autonomous Circuit at the pinned commit and run the KiCad package's OWN setup in it (Freerouting
# jar + JRE, the board viewer). Nothing is installed onto the machine.
set -euo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
. toolchain/runtimes.sh
. toolchain/kicad.sh
harness_node 22.12 || exit 1
harness_venv .venv 3.12 3.10 || exit 1
harness_kicad || exit 1
toolchain/fetch-upstream.sh
[ -x upstream/harness/kicad/toolchain/setup.sh ] || { echo "miss upstream/harness/kicad/toolchain/setup.sh"; exit 1; }
# The package's setup also vendors the RP2040 firmware toolchain (Arm GNU + pico-sdk + picotool,
# ~1.1 GB) and cmake + ninja as PyPI wheels — on this wrapper's venv Python, so a blank Mac needs
# neither (the Firmware phase is done only when the binary is built).
HARNESS_DSH_DIR="$PWD/upstream/harness/kicad" CIRCUIT_PYTHON="$PWD/toolchain/python" \
  PICO_TOOLS_PYTHON="$PWD/.venv/bin/python" \
  KICADPY_CLI="$KICAD_CLI" KICADPY_PYTHON="$KICAD_PYTHON" CIRCUIT_KICAD_CLI="$KICAD_CLI" \
  upstream/harness/kicad/toolchain/setup.sh
