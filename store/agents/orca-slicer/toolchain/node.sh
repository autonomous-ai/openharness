#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/runtimes.sh"
harness_node 22 || exit 1
exec node "$@"
