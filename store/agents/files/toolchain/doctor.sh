#!/usr/bin/env bash
# The Node the viewer runs on (runtimes.sh: this machine's or Harness's own), and the viewer's own files.
set -u; cd "$(dirname "$0")/.."
# shellcheck source=runtimes.sh
. ./toolchain/runtimes.sh
harness_node 20 || exit 1
for f in viewer.mjs viewer.sh app/index.html; do
  [ -f "$f" ] || { echo "miss $f — the package is incomplete"; exit 1; }
done
echo "ok   node $(node --version) runs the viewer (no other toolchain)"
