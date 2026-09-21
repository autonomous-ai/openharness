#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if harness_node 18; then echo "ok   node $(node --version) (the pane server)"; else bad=1; fi
if [ -f node_modules/@excalidraw/excalidraw/dist/excalidraw.production.min.js ]; then echo "ok   excalidraw $(node -p "require('@excalidraw/excalidraw/package.json').version" 2>/dev/null)"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
if [ -f viewer.mjs ] && [ -f viewer/index.html ] && [ -f viewer/app.js ]; then echo "ok   pane (viewer.mjs, viewer/)"; else echo "miss viewer.mjs or viewer/ — the checkout is incomplete"; bad=1; fi
if command -v python3 >/dev/null 2>&1; then echo "ok   $(python3 --version)"; else echo "miss python3"; bad=1; fi
exit $bad
