#!/usr/bin/env bash
# Harness DSH viewer — a loopback server that renders the workspace's deck as a scrolling stack of
# slides, re-renders on every save, and keeps .harness/verdict.json current as it goes.
#
# Harness runs this for the life of the agent's pane with:
#   HARNESS_VIEWER_PORT   the loopback port to listen on
#   HARNESS_WORKSPACE     the workspace folder (the agent's cwd)
#   HARNESS_DSH_DIR       this install dir (also the cwd)
#
# The daemon starts it through a login shell whose PATH may hold no node at all.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${HARNESS_VIEWER_PORT:?HARNESS_VIEWER_PORT is required}"
: "${HARNESS_WORKSPACE:?HARNESS_WORKSPACE is required}"
# shellcheck source=runtimes.sh
. "$ROOT/toolchain/runtimes.sh"
harness_node 18 || exit 1
exec node "$ROOT/toolchain/viewer.mjs"
