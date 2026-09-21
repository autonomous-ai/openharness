#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
workspace="$(cd "$here/.." && pwd)"
if ! command -v uv >/dev/null 2>&1; then
  echo "Install uv from https://docs.astral.sh/uv/getting-started/installation/ and run this command again."
  exit 1
fi
if [ -L "$workspace/.harness" ] || [ -L "$workspace/.harness/runtime" ]; then
  echo "Refusing a symlink runtime directory."
  exit 1
fi
mkdir -p "$workspace/.harness"
UV_PROJECT_ENVIRONMENT="$workspace/.harness/runtime" uv sync --locked --no-dev --project "$here" --python 3.14.7
"$workspace/.harness/runtime/bin/python" -I -c 'import importlib.metadata,sys; assert importlib.metadata.version("homeassistant")=="2026.9.3"; print("ok   Python",sys.version.split()[0],"/ Home Assistant Core 2026.9.3 — isolated testing only")'
