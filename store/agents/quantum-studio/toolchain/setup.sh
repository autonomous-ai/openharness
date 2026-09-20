#!/bin/sh
# Verify the tools Quantum Studio needs. cwd = the package install dir.
# The simulator is fully browser-native, so the only host tool is Node for the headless proof/tests.
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"

if command -v node >/dev/null 2>&1; then
  echo "ok   node on PATH ($(command -v node) $(node --version 2>/dev/null))"
else
  echo "miss node — Quantum Studio needs Node 18+ only for its headless proof and tests."
  echo "      Install from https://nodejs.org or 'brew install node', then re-run setup."
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  echo "ok   python3 on PATH (optional, for extra analysis scripts)"
else
  echo "warn python3 not found — optional; not required to run the simulator"
fi
[ -d "$dsh/skills/quantum" ] && echo "ok   quantum skill" || echo "warn quantum skill missing"
exit 0
