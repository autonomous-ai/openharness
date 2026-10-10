#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Memories installs nothing: it reads the agents' own memory
# folders and the session index Harness already keeps. All it needs is Node 22 (for node:sqlite).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 22 || exit 1
echo "ok   node $(node --version) (the mem command and the pane)"
