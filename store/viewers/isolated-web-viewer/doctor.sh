#!/usr/bin/env bash
# Exit 0 when this machine can run the viewer: only Node 20 or newer is needed — this machine's, or
# Harness's own when it has none or too old a one (runtimes.sh, as viewer.sh finds it).
set -u
# shellcheck source=runtimes.sh
. "$(dirname "$0")/runtimes.sh"
harness_node 20 || exit 1
echo "ok   node $(node --version)"
