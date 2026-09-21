#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: fetch Autonomous Workshop at the pinned commit, then
# run the project's OWN setup in it (a .venv from its pinned uv.lock, Python >= 3.11). That setup
# needs uv on PATH and a new Mac has none: the pinned one from runtimes.sh stands in.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_uv || exit 1
toolchain/fetch-upstream.sh
[ -x upstream/harness/toolchain/setup.sh ] || { echo "miss upstream/harness/toolchain/setup.sh"; exit 1; }
HARNESS_DSH_DIR="$PWD/upstream" upstream/harness/toolchain/setup.sh
# The first import of OCP and vtk from a new .venv takes minutes (macOS verifies each new library on
# first load) and the project's doctor makes it: paid here, in setup's time, not in the doctor's.
echo "     loading cadgen and OpenCascade once (the first load is slow, the rest are not)"
upstream/.venv/bin/python -c 'import cadgen, build123d' >/dev/null 2>&1 || true
