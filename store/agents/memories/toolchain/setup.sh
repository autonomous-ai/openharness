#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Memories installs nothing: it reads the agents' own memory
# folders and the session index Harness already keeps. All it needs is Node 22 (for node:sqlite).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 22 || exit 1
echo "ok   node $(node --version) (the mem command and the pane)"
# Copies of About You name where it lives (Claude Code's hook reads the file there). Harness moving its folders
# moves About You and runs every package's setup again before the old place goes, so the copies follow here. A
# copy that cannot be written is not this package failing to install; `mem deliver status` names it.
node --disable-warning=ExperimentalWarning toolchain/mem.mjs deliver refresh >/dev/null \
  || echo "warn About You could not be refreshed in every agent; \`mem deliver status\` says which"
