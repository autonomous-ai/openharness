#!/bin/sh
# Install/verify the runtime for this harness. cwd = the package install dir.
# Data Studio is web-native: the shared isolated-web-viewer renders index.html in the pane. The only
# local runtime the harness needs is Node (it drives the data helpers and the test suite).
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
if command -v node >/dev/null 2>&1; then
  echo "ok   node $(node --version 2>/dev/null) at $(command -v node)"
  exit 0
fi
echo "miss node — install Node.js 20+ from https://nodejs.org (or via nvm/brew) and re-run setup."
exit 1
