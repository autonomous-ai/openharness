#!/bin/sh
# Build and prove the circuit using the same engine as the interactive viewer.
set -eu
here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
exec node "$here/build.mjs"
