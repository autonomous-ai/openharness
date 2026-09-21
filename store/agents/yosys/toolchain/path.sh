# shellcheck shell=bash
# path.sh — sourced by flow.sh, doctor.sh and run: the FPGA tools and node on PATH, however this
# process started (the daemon's PATH and the agent's shell may have neither Homebrew's bin nor a node).
#
#   1. oss-cad-suite/bin in this install, when setup.sh fetched the suite because the machine lacked
#      a tool — first, so the flow never mixes the suite's tools with the machine's
#   2. otherwise the machine's own, with Homebrew's bin added when yosys is not already visible
#   3. node for netlistsvg: this machine's when it is new enough, else the Node Harness itself runs on
_yosys_install="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -x "$_yosys_install/oss-cad-suite/bin/yosys" ]; then
  PATH="$_yosys_install/oss-cad-suite/bin:$PATH"
elif ! command -v yosys >/dev/null 2>&1; then
  PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
fi
export PATH
# shellcheck source=runtimes.sh
. "$_yosys_install/toolchain/runtimes.sh"
harness_node 18 >/dev/null || true
