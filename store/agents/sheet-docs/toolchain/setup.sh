#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$HERE/node.sh" --version
if [ -n "${SOFFICE_BIN:-}" ]; then "$SOFFICE_BIN" --version; elif command -v soffice >/dev/null 2>&1; then soffice --version; elif [ -x /Applications/LibreOffice.app/Contents/MacOS/soffice ]; then /Applications/LibreOffice.app/Contents/MacOS/soffice --version; else echo "miss LibreOffice — install from https://www.libreoffice.org/download/ or set SOFFICE_BIN for PDF preview and workbook recalculation"; exit 1; fi
