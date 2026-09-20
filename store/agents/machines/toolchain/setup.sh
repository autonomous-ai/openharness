#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/runtimes.sh
harness_node 22
echo "ok   node $(node -v) (the pane and the fleet commands need nothing else)"
echo "ok   Machines talks to Harness on this computer — no service to install, no model to download"
