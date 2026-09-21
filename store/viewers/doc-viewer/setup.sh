#!/usr/bin/env bash
# Runs once at install, cwd = the install dir: pdf.js into node_modules, from the lockfile. The reader
# itself (app/, lib/, viewer.mjs) has no build step. Node is this machine's, or Harness's own when the
# machine has none or too old a one (runtimes.sh); npm is the one beside it.
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=runtimes.sh
. ./runtimes.sh
harness_node 20 || exit 1
command -v npm >/dev/null 2>&1 || { echo "miss npm beside node $(node --version)"; exit 1; }
npm ci --silent --no-audit --no-fund
for f in build/pdf.min.mjs build/pdf.worker.min.mjs web/pdf_viewer.mjs web/pdf_viewer.css legacy/build/pdf.min.mjs legacy/web/pdf_viewer.mjs; do
  [ -f "node_modules/pdfjs-dist/$f" ] || { echo "miss pdfjs-dist/$f after npm ci"; exit 1; }
done
echo "ok   pdf.js $(node -p "require('pdfjs-dist/package.json').version") (viewer components, modern and legacy builds)"
