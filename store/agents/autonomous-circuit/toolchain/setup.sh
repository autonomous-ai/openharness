#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: fetch Autonomous Circuit at the pinned commit, then
# run the project's OWN setup in it (pinned tscircuit toolchain, skill runtimes, the board viewer).
# What that setup and the board pipeline take from PATH is provided here first, since a new Mac has
# neither: a Node >= 22.12 with npm (Vite 7's floor; Harness's own when the machine has none), and a
# Python >= 3.10 with numpy (the pipeline's floor and its gates) in .venv, which toolchain/python runs
# as the agent's CIRCUIT_PYTHON.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 22.12 || exit 1
harness_venv .venv 3.12 3.10 || exit 1
harness_pip .venv numpy
echo "ok   numpy $(.venv/bin/python -c 'import numpy; print(numpy.__version__)') (the board pipeline's gates)"
toolchain/fetch-upstream.sh
[ -x upstream/harness/toolchain/setup.sh ] || { echo "miss upstream/harness/toolchain/setup.sh"; exit 1; }
HARNESS_DSH_DIR="$PWD/upstream" upstream/harness/toolchain/setup.sh
