#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Roundtable has no dependencies to fetch: the panel is
# the coding-agent CLIs the user already has, and the pane is one generated HTML file. All this does
# is make sure there is a Node to render with, and say which engines could be seated today.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
harness_node 18 || exit 1
echo "ok   node $(node --version) (the room engine and the pane)"
seats=$(node toolchain/room.mjs seats 2>/dev/null | grep -c . || true)
if [ "${seats:-0}" -gt 0 ]; then
  node toolchain/room.mjs seats | sed 's/^/     /'
else
  echo "warn no engine CLIs on PATH yet — install claude, codex, opencode, grok, pi or hermes to seat a panel"
fi
