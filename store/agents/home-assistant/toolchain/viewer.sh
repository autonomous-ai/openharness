#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export HA_DSH_DIR="$(cd "$here/.." && pwd)"
workspace="${HARNESS_WORKSPACE:-$PWD}"
exec bash "$here/node.sh" "$workspace/tools/serve.mjs" "$workspace"
