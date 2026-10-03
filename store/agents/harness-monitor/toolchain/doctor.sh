#!/usr/bin/env bash
# Read-only diagnosis: the daemon is authoritative, including for linked machines.
set -u
cd "$(dirname "$0")/.."
bad=0
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if harness_node 22; then echo "ok   node $(node --version)"; else bad=1; fi
seen=$(node toolchain/hps.mjs ls --json --all 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.problems?.length)process.exit(1);console.log(j.rows.length)}catch{process.exit(1)}})')
if [ -n "${seen:-}" ]; then
  echo "ok   daemon inventory is readable ($seen harnesses in view)"
else
  echo "miss could not read daemon inventory — start or reconnect Harness"
  bad=1
fi
exit "$bad"
