#!/usr/bin/env bash
# The pane. Harness runs this here with HARNESS_VIEWER_PORT, HARNESS_WORKSPACE and HARNESS_DSH_DIR
# (the harness that uses this viewer — where its Menagerie robots are), through a login shell whose
# PATH may hold no node: runtimes.sh finds this machine's or Harness's own.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}"; : "${HARNESS_WORKSPACE:?}"
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=runtimes.sh
. "$here/runtimes.sh"
harness_node 18 || exit 1
exec node "$here/viewer.mjs"
