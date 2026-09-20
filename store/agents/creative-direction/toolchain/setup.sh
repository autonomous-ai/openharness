#!/bin/sh
# Browser exports use pinned tools installed in this package, never globally.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node -e 'if(Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'
cd "$here"
npm ci --ignore-scripts --no-audit --no-fund
node browser.mjs --install
