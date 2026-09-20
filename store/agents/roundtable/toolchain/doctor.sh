#!/usr/bin/env bash
# exit 0 = ready. Roundtable is ready when there is a Node and at least two engines from different
# vendors: one seat is not a panel, it is a chat.
set -u; cd "$(dirname "$0")/.."; bad=0
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if harness_node 18; then echo "ok   node $(node --version)"; else bad=1; fi
if [ -f toolchain/room.mjs ] && [ -f toolchain/lib/render.mjs ]; then echo "ok   room engine and pane renderer"; else echo "miss toolchain/ — the checkout is incomplete"; bad=1; fi
seats=$(node toolchain/room.mjs seats 2>/dev/null | grep -cE '^(claude|codex|opencode|grok|pi|hermes) ' || true)
case "${seats:-0}" in
  0) echo "miss no engine CLIs on PATH — a room needs at least one seat (claude, codex, opencode, grok, pi, hermes)"; bad=1 ;;
  1) echo "warn only one engine CLI on PATH — the panel will be one vendor arguing with itself" ;;
  *) echo "ok   $seats engine CLIs on PATH (a seat still needs that vendor's own login)"; node toolchain/room.mjs seats 2>/dev/null | grep -E '^(claude|codex|opencode|grok|pi|hermes) ' | sed 's/^/     /' ;;
esac
exit $bad
