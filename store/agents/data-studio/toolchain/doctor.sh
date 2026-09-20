#!/bin/sh
# Exit 0 when this machine can run the Data Studio harness. Print one line per check.
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
fail=0
if command -v node >/dev/null 2>&1; then
  echo "ok   node $(node --version 2>/dev/null) at $(command -v node)"
else
  echo "miss node — run toolchain/setup.sh or install Node.js 20+ from https://nodejs.org"
  fail=1
fi
[ -d "$dsh/skills/data" ] && echo "ok   data skill" || { echo "warn data skill missing"; fail=1; }
exit $fail
