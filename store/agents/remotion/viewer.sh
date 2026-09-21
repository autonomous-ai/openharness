#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE. viewer.mjs starts
# Remotion Studio on the workspace (on a private loopback port, BROWSER=none) and serves the pane on
# HARNESS_VIEWER_PORT: Studio itself, plus the renders in out/ and the render in progress.
# The daemon starts it through a login shell whose PATH may hold no node at all; Studio inherits ours.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=toolchain/runtimes.sh
. "$here/toolchain/runtimes.sh"
harness_node 18 || exit 1
exec node "$here/viewer.mjs"
