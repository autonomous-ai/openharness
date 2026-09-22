#!/usr/bin/env bash
# exit 0 = ready. Harness Monitor is ready when it can see the fleet: a Node to run on, tmux to read, and either
# the daemon's local bridge or its registry file.
set -u; cd "$(dirname "$0")/.."; bad=0
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if harness_node 22; then echo "ok   node $(node --version)"; else bad=1; fi
if command -v tmux >/dev/null 2>&1; then echo "ok   tmux $(tmux -V | awk '{print $2}')"; else echo "miss tmux is not on PATH — pausing needs it"; bad=1; fi
seen=$(node toolchain/hps.mjs ls --json --all 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log(j.rows.length)}catch{console.log("")}})')
if [ -n "${seen:-}" ]; then
  echo "ok   the fleet is readable ($seen harnesses in view)"
else
  echo "miss could not read the fleet — start Harness, or check that ~/.harness/cli/data/registry.json is readable"; bad=1
fi
exit $bad
