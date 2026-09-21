#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/runtimes.sh"
harness_node 22.12 || exit 1
echo "ok   node $(node --version)"
