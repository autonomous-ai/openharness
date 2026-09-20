#!/bin/sh
set -u
dsh="${HARNESS_DSH_DIR:-$PWD}"
if [ ! -f "$dsh/node_modules/yaml/package.json" ]; then echo "miss YAML parser — run toolchain/setup.sh"; exit 1; fi
if ! command -v node >/dev/null 2>&1; then echo "warn node not on PATH — build uses the managed Node bootstrap"; fi
echo "ok   YAML parser; local config-only authoring and scenario preview"
echo "note No live Home Assistant instance or device services are contacted"
