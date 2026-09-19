#!/bin/sh
set -eu
dsh="${HARNESS_DSH_DIR:-$PWD}"
bash "$dsh/toolchain/node.sh" --version
cd "$dsh"
# Node bootstrap also makes npm available in its child shell.
exec bash -c '. "$1/toolchain/runtimes.sh"; harness_node 20 && npm ci --omit=dev --ignore-scripts --no-audit --no-fund' sh "$dsh"
