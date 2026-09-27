#!/bin/sh
# Build the cli and backend of another ref, for the sandbox's mixed-version matrix (daemons.e2e.test.mjs):
#
#   daemons/e2e/build-ref.sh origin/main "$E2E_DIR/old-main"
#   E2E_OLD_CLI="$E2E_DIR/old-main/cli" E2E_OLD_BACKEND="$E2E_DIR/old-main/backend" …
#
# A plain export of the ref (no worktree, no checkout), its own node_modules, and the same builds the sandbox
# runs for the branch: cli/dist/cli.js and backend/dist/server.js.
set -eu
ref="${1:?usage: build-ref.sh <ref> <out-dir>}"
out="${2:?usage: build-ref.sh <ref> <out-dir>}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$out"
git -C "$repo" rev-parse "$ref" > "$out/REF"
git -C "$repo" archive "$ref" cli backend store | tar -x -C "$out"
(cd "$out/cli" && npm ci --no-audit --no-fund --prefer-offline >/dev/null && node build.mjs >/dev/null)
(cd "$out/backend" && npm ci --no-audit --no-fund --prefer-offline >/dev/null && node build.mjs >/dev/null)
echo "built $ref ($(cut -c1-8 "$out/REF")) in $out"
