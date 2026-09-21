#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bash "$here/node.sh" "$here/../viewer/viewer.mjs"
