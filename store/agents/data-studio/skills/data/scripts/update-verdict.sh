#!/bin/sh
set -eu
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
toolchain="${DATA_TOOLCHAIN:-$here/../../../toolchain}"
workspace="${HARNESS_WORKSPACE:-$PWD}"
bash "$toolchain/node.sh" "$workspace/tools/build.mjs" "$workspace"
exec bash "$toolchain/node.sh" "$here/screenshot.mjs" "$workspace/index.html"
