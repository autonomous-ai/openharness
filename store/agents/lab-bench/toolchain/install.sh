#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/runtimes.sh"
harness_node 20 || exit 1
cd "$here"
npm ci --ignore-scripts --no-audit --no-fund
node browser.mjs --install
node --input-type=module -e 'await import("esbuild");console.log("ok   offline experiment build tools")'
