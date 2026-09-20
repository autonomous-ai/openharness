#!/usr/bin/env bash
# Doctor: run the whole chain — Chrome, a page, the reader, one Jev call — and say which link broke.
# Pass a web address to try that site instead of the built-in one, or --show for a visible window.
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then echo "fail   node is required (Node 22+)"; exit 1; fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" 2>/dev/null; then
  echo "fail   node >= 22 required for the built-in WebSocket (found $(node -v))"; exit 1
fi
cd "$(dirname "$0")/.."
exec node toolchain/selftest.mjs "$@"
