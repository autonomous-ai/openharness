#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): write the first verdict so the pane header says
# something true before the agent's first turn.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness
HARNESS_WORKSPACE="$PWD" "$HARNESS_DSH_DIR/toolchain/hps" observe >/dev/null 2>&1 || true
