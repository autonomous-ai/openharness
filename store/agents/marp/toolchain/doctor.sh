#!/usr/bin/env bash
# Harness DSH doctor — can THIS machine write, show and export a deck? cwd = the install dir.
# One line per check: `ok   <what>` / `warn <what>` / `miss <what>`. Exit 1 only on a miss.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=runtimes.sh
. "$ROOT/toolchain/runtimes.sh"
# shellcheck source=browser.sh
. "$ROOT/toolchain/browser.sh"
status=0
ok()   { echo "ok   $*"; }
warn() { echo "warn $*"; }
miss() { echo "miss $*"; status=1; }

# The engine (claude) is Harness's to find, like every other package's; this checks what setup provides.
# node: this machine's when it is new enough, else the Node Harness itself runs on.
if harness_node 18 >/dev/null; then
  ok "node $(node --version | sed 's/^v//')"
else
  harness_node 18; status=1
fi

if [ -d "$ROOT/toolchain/node_modules/@marp-team/marp-core" ]; then
  ok "marp-core $(node -p "require('$ROOT/toolchain/node_modules/@marp-team/marp-core/package.json').version" 2>/dev/null || echo present)"
else
  miss "marp toolchain not installed — run toolchain/setup.sh"
fi
if [ -x "$ROOT/toolchain/node_modules/.bin/marp" ]; then
  ok "marp-cli (PDF, PPTX and HTML export)"
else
  warn "marp-cli missing — decks show live but do not export"
fi

if [ -f "$ROOT/toolchain/viewer.mjs" ] && [ -f "$ROOT/toolchain/viewer/index.html" ] && [ -f "$ROOT/toolchain/viewer/app.js" ]; then
  ok "viewer pane (slide, grid, presenter, present)"
else
  miss "toolchain/viewer/ is incomplete — reinstall the harness"
fi

# Export to PDF/PPTX renders through a Chromium-family browser: this machine's, or the headless shell
# setup.sh fetched when it had none.
if found="$(marp_browser)"; then ok "browser for PDF/PPTX export: $(basename "$found")"; else warn "no Chrome/Chromium/Edge — HTML export only until toolchain/setup.sh fetches a headless one"; fi

exit $status
