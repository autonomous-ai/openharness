#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node -e 'if(Number(process.versions.node.split(".")[0]) < 20) process.exit(1); console.log("ok   Node.js (authoring tools)")'
node "$here/browser.mjs" --check
