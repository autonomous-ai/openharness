#!/usr/bin/env bash
# Launch the Jev Browser viewer (a real Chrome, driven by Jev, reading pages into results.csv).
set -euo pipefail
cd "$(dirname "$0")/.."
HARNESS_DSH_DIR="${HARNESS_DSH_DIR:-$PWD}"
exec node viewer/viewer.mjs
