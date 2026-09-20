#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
. "$here/toolchain/runtimes.sh"
harness_node 22 >/dev/null
exec node "$here/toolchain/machines.mjs" init
