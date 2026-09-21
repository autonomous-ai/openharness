#!/usr/bin/env bash
set -u; cd "$(dirname "$0")"
fail=0
# The same Node setup.sh uses, found the same way: a doctor that passes where setup fails helps no one.
# shellcheck source=runtimes.sh
. ./runtimes.sh
if harness_node 18; then echo "ok   node $(node --version)"; else fail=1; fi
if [ -f node_modules/three/build/three.module.js ] && [ -f node_modules/three/examples/jsm/loaders/GLTFLoader.js ]; then
  echo "ok   three $(node -p "require('./node_modules/three/package.json').version")"
else
  echo "miss node_modules/three — run ./setup.sh"; fail=1
fi
[ -f web/index.html ] && [ -f web/app.js ] || { echo "miss web/ — the package is incomplete"; fail=1; }
exit $fail
