#!/usr/bin/env bash
# The Node setup.sh uses, found the same way (runtimes.sh), then what it installed.
set -u; cd "$(dirname "$0")"
# shellcheck source=runtimes.sh
. ./runtimes.sh
harness_node 20 || exit 1
for f in build/pdf.min.mjs build/pdf.worker.min.mjs web/pdf_viewer.mjs web/pdf_viewer.css legacy/build/pdf.min.mjs legacy/web/pdf_viewer.mjs; do
  [ -f "node_modules/pdfjs-dist/$f" ] || { echo "miss node_modules/pdfjs-dist/$f — run ./setup.sh"; exit 1; }
done
for f in app/index.html app/app.js app/app.css app/reviews.mjs lib/workspace.mjs lib/reviews.mjs lib/zip.mjs; do
  [ -f "$f" ] || { echo "miss $f — the package is incomplete"; exit 1; }
done
echo "ok   pdf.js $(node -p "require('pdfjs-dist/package.json').version") and the reader"
