#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dsh="$(cd "$here/.." && pwd)"
. "$here/runtimes.sh"
harness_node 22 || exit 1
harness_uv || exit 1
if [ -L "$dsh/.runtime" ] || [ -L "$dsh/.runtime/core" ]; then
  echo "miss runtime directory must not be a symlink"; exit 1
fi
UV_PROJECT_ENVIRONMENT="$dsh/.runtime/core" uv sync --locked --no-dev --project "$dsh/template/tools" --python 3.14.7
cd "$dsh"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if [ -z "${BROWSER_EXECUTABLE:-}" ]; then
  node node_modules/playwright-core/cli.js install chromium
fi
bash "$here/doctor.sh"
