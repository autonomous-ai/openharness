#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export HA_DSH_DIR="${HA_DSH_DIR:-$(cd "$here/../../.." && pwd)}"
workspace="${HARNESS_WORKSPACE:-$PWD}"
bash "$HA_DSH_DIR/toolchain/node.sh" "$here/build.mjs"
exec bash "$HA_DSH_DIR/toolchain/node.sh" "$workspace/tools/proof.mjs" "$workspace"
