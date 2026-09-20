#!/bin/sh
set -eu
exec node "$(dirname "$0")/screenshot.mjs" "${HARNESS_WORKSPACE:-$PWD}/index.html"
