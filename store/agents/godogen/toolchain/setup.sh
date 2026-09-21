#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. ./VERSIONS
. toolchain/runtimes.sh
harness_node 22.12 || exit 1
if [ ! -d upstream/.git ]; then
  git init -q upstream
  git -C upstream remote add origin https://github.com/htdt/godogen.git
fi
if [ "$(git -C upstream rev-parse HEAD 2>/dev/null || true)" != "$GODOGEN_COMMIT" ]; then
  git -C upstream fetch --depth 1 origin "$GODOGEN_COMMIT"
  git -C upstream checkout --detach "$GODOGEN_COMMIT"
fi
echo 'Preparing Godogen’s Babylon.js instructions and asset-generation skill'
node toolchain/publish-runtime.mjs
npm ci --omit=dev --no-audit --no-fund
exec toolchain/doctor.sh
