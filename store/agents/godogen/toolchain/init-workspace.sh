#!/usr/bin/env bash
# Runs once in a fresh workspace (cwd = the workspace); the work is init-workspace.mjs. The daemon runs
# this through a login shell whose PATH may hold no node at all — the normal case on a machine Harness
# set up itself — and a `#!/usr/bin/env node` script there dies with "env: node: No such file or
# directory", leaving a workspace with no node_modules for the viewer. runtimes.sh finds this machine's
# Node 22.12+, or Harness's own.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=runtimes.sh
. "$here/runtimes.sh"
harness_node 22.12 || exit 1
exec node "$here/init-workspace.mjs" "$@"
