#!/usr/bin/env bash
# Doctor: what this harness needs to drive a real browser.
set -euo pipefail
if ! command -v node >/dev/null 2>&1; then echo "fail   node is required (Node 22+)"; exit 1; fi
if ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" 2>/dev/null; then
  echo "fail   node >= 22 required for the built-in WebSocket (found $(node -v))"; exit 1
fi
echo "ok   node $(node -v)"
cd "$(dirname "$0")/.."
node -e "import('./toolchain/chrome.mjs').then((m) => { const p = m.findChrome(); console.log(p ? 'ok   Google Chrome: ' + p : 'fail   Google Chrome was not found. Install it, or set CHROME_PATH to where it is.'); process.exit(p ? 0 : 1) })"
node -e "import('./toolchain/jev.mjs').then((m) => console.log('ok   Jev: ' + m.describeCredentials())).catch((e) => console.log('warn   Jev client did not load: ' + e.message))"
echo "done"
