#!/bin/sh
# Exit 0 when this machine can run Quantum Studio. One line per check; Harness shows them.
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
fail=0
if command -v node >/dev/null 2>&1; then
  echo "ok   node on PATH ($(command -v node))"
else
  echo "miss node — run toolchain/setup.sh (Node 18+ for the proof/tests)"
  fail=1
fi
if command -v python3 >/dev/null 2>&1; then
  echo "ok   python3 on PATH (optional)"
else
  echo "warn python3 not found (optional)"
fi
[ -d "$(dirname "$0")/../skills/quantum" ] && echo "ok   quantum skill" || echo "warn quantum skill missing"
exit $fail
