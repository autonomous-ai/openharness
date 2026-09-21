#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): links the shared node_modules in (instant,
# and one copy of Remotion for every workspace) and seeds the verdict.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness out public
[ -e node_modules ] || ln -s "$HARNESS_DSH_DIR/node_modules" node_modules
# The verdict bundles through Remotion's CLI, a node script: node on PATH for it (the seed is best-effort).
# shellcheck source=runtimes.sh
. "$HARNESS_DSH_DIR/toolchain/runtimes.sh"
harness_node 18 >/dev/null || true
python3 "$HARNESS_DSH_DIR/toolchain/verdict.py" >/dev/null 2>&1 || true
