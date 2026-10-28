#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."
if [ -x bin/typst ]; then echo "ok   $(bin/typst --version)"; else echo "miss bin/typst — run toolchain/setup.sh"; exit 1; fi
if PYTHON_VERSION="$(python3 --version 2>/dev/null)"; then echo "ok   $PYTHON_VERSION for the verdict"; else echo "miss python3 for the verdict"; exit 1; fi
