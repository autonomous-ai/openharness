#!/bin/sh
set -eu
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
workspace="${HARNESS_WORKSPACE:-$PWD}"
bash "$here/node.sh" "$workspace/tools/build.mjs" "$workspace"
printf 'Data Studio workspace initialized by %s\n' "${HARNESS_DSH:-autonomous/data-studio}" > "$workspace/.harness-initialized"
