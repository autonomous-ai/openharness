#!/usr/bin/env bash
# Bundles the driver into one file, <out>/e2e.mjs (default: this folder), for `node e2e.mjs` on the Windows machine.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here}
"$here/../../node_modules/.bin/esbuild" "$here/e2e.mts" --bundle --platform=node --format=esm --target=node22 \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile="$out/e2e.mjs" --log-level=warning
echo "$out/e2e.mjs"
