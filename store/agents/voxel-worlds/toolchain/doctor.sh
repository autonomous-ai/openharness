#!/bin/sh
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$here"
bash node.sh --input-type=module -e 'if(Number(process.versions.node.split(".")[0])<20)process.exit(1);await import("esbuild");await import("three");console.log("ok   Node and offline world build tools")'
bash node.sh browser.mjs --check
