#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bash "$HERE/../../../toolchain/node.sh" "$HERE/build.mjs"
