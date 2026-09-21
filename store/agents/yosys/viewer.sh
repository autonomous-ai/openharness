#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE.
# The daemon starts it through a login shell whose PATH may hold no node at all; path.sh also puts the
# package's OSS CAD Suite on PATH, where the pane finds IceStorm's chip database beside icepack.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=toolchain/path.sh
. "$here/toolchain/path.sh"
harness_node 18 || exit 1
exec node "$here/viewer.mjs"
