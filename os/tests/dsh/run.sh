#!/usr/bin/env bash
set -euo pipefail
INPUTS=$(cd -- "$(dirname -- "$0")" && pwd)
ROOT="$HOME/Projects/os-dsh"
REPORT="$HOME/.local/state/harness-os/dsh-check"
mkdir -p "$REPORT" "$ROOT/qa"
trap 'printf "%s\n" "$?" > "$REPORT/status"' EXIT
python3 "$INPUTS/prepare.py" "$INPUTS/components" "$ROOT"
for viewer in web-viewer game-viewer; do
    harness dsh check "$INPUTS/components/viewers/$viewer"
    harness dsh install "$INPUTS/components/viewers/$viewer" --link
done
for package in hello logs game; do
    harness dsh check "$ROOT/packages/$package"
    harness dsh install "$ROOT/packages/$package" --link
    harness dsh doctor "os-lab/$package"
done
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --prefix "$ROOT/qa" --no-audit --no-fund playwright
cp "$INPUTS/exercise.mjs" "$ROOT/qa/exercise.mjs"
node "$ROOT/qa/exercise.mjs" "$ROOT" "$REPORT"
