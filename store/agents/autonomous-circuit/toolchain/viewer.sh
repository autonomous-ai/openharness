#!/usr/bin/env bash
# The project's own board viewer, over the agent's workspace, on the port Harness hands it. Harness
# starts it through a login shell that may have no node: Harness's own stands in. Its board check
# runs the pipeline, so it gets the pipeline's Python too.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=runtimes.sh
. "$here/toolchain/runtimes.sh"
harness_node 22.12 || exit 1
HARNESS_DSH_DIR="$here/upstream" CIRCUIT_PYTHON="${CIRCUIT_PYTHON:-$here/toolchain/python}" \
  exec "$here/upstream/harness/toolchain/viewer.sh"
