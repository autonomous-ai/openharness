#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: three.js into node_modules, from the lockfile, then the
# server's smoke test (npm test is the whole suite; install needs only the smoke test). Nothing here touches the machine outside this directory.
# Node is this machine's, or Harness's own when the machine has none or too old a one (runtimes.sh);
# npm is the one beside it.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=runtimes.sh
. ./runtimes.sh
harness_node 18 || exit 1
command -v npm >/dev/null 2>&1 || { echo "miss npm beside node $(node --version)"; exit 1; }
npm ci --silent --no-audit --no-fund
[ -f node_modules/three/build/three.module.js ] || { echo "miss three after npm ci"; exit 1; }
[ -f node_modules/three/examples/jsm/loaders/GLTFLoader.js ] || { echo "miss three's glTF loader after npm ci"; exit 1; }
npm run smoke --silent
echo "ok   three $(node -p "require('./node_modules/three/package.json').version") (3D Viewer)"
