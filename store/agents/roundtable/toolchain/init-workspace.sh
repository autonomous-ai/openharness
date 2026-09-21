#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace): an empty room that already draws, so the pane
# has something to show before the first seat is filled.
set -euo pipefail
: "${HARNESS_DSH_DIR:?}"
mkdir -p .harness rounds
HARNESS_WORKSPACE="$PWD" "$HARNESS_DSH_DIR/toolchain/room" render >/dev/null 2>&1 || true
