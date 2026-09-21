#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the cadgen release every skill in
# skills/ pins (their requirements.txt), plus the extras dfam-check needs and the browser snapshots
# render with (in .playwright, which harness.json hands the agent as PLAYWRIGHT_BROWSERS_PATH). Nothing
# is installed outside this directory and ~/.harness/runtime. cadgen wants Python 3.11+ and
# cadquery-ocp has wheels for 3.11–3.14, so the venv is on 3.12 whatever this machine has (uv downloads
# it when it is not here); a venv already on 3.11–3.14 is kept. cadgen's mesh exports run in Node:
# toolchain/node.sh finds one.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
CADGEN_VERSION="$(cat CADGEN_VERSION)"
harness_venv .venv 3.12 3.11 3.15 || exit 1
echo "     installing cadgen $CADGEN_VERSION and the skills' extras (OpenCascade comes with it; minutes the first time)"
harness_pip .venv "cadgen[snapshot]==${CADGEN_VERSION}" trimesh numpy scipy rtree networkx lxml
echo "ok   cadgen $CADGEN_VERSION"
node_version="$(toolchain/node.sh --version 2>&1)" || { echo "$node_version"; exit 1; }
echo "ok   node $node_version (STL, 3MF and GLB exports)"
echo "     installing the browser snapshots render with"
# Headless shell only: cadgen launches Chromium headless, and the full browser is another 360 MB.
if PLAYWRIGHT_BROWSERS_PATH="$PWD/.playwright" .venv/bin/python -m playwright install --only-shell chromium >/dev/null 2>&1; then echo "ok   chromium for snapshots"; else echo "warn chromium for snapshots did not install; \`cadgen … snapshot\` will not render until toolchain/setup.sh runs again"; fi
