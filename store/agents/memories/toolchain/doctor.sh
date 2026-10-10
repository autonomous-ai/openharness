#!/usr/bin/env bash
# Read-only diagnosis: can this machine read the agents' memories and the session index?
set -u
cd "$(dirname "$0")/.."
bad=0
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
if harness_node 22; then echo "ok   node $(node --version)"; else bad=1; fi
if node --disable-warning=ExperimentalWarning -e "require('node:sqlite')" 2>/dev/null; then
  echo "ok   built-in SQLite (your sessions)"
else
  echo "warn this Node has no built-in SQLite — memories still show, sessions do not"
fi
seen=$(node --disable-warning=ExperimentalWarning toolchain/mem.mjs list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).length)}catch{process.exit(1)}})')
if [ -n "${seen:-}" ]; then echo "ok   $seen memories readable on this computer"; else echo "miss could not read the agents' memory folders"; bad=1; fi
exit "$bad"
