#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Harness Monitor installs nothing: it reads the daemon Harness
# already runs. All this needs is Node and the Harness CLI.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 22 || exit 1
echo "ok   node $(node --version) (the hps CLI and the pane)"
if command -v harness >/dev/null 2>&1; then echo "ok   harness CLI on PATH (the local bridge to the daemon)"
else echo "warn the harness CLI is not on PATH — reconnect Harness before using the monitor"; fi
