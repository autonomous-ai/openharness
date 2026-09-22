#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Harness Monitor installs nothing: it reads the daemon Harness
# already runs, the tmux server it already uses, and the process table. All this needs is a Node.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 22 || exit 1
echo "ok   node $(node --version) (the hps CLI and the pane)"
if command -v tmux >/dev/null 2>&1; then echo "ok   tmux $(tmux -V | awk '{print $2}') (where every harness lives)"
else echo "warn tmux is not on PATH — Harness Monitor can list the fleet but not pause anything"; fi
if command -v harness >/dev/null 2>&1; then echo "ok   harness CLI on PATH (the local bridge to the daemon)"
else echo "warn the harness CLI is not on PATH — Harness Monitor will read the registry file instead, without models or branches"; fi
