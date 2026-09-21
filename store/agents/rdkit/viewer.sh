#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE, through a login
# shell whose PATH may have no node: this machine's Node when it is new enough, else Harness's own.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=toolchain/runtimes.sh
. "$DIR/toolchain/runtimes.sh"
harness_node 18 || exit 1
exec node "$DIR/viewer.mjs"
