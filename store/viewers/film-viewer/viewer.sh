#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
export OPENMONTAGE_PROJECTS_DIR="${HARNESS_WORKSPACE:?}/projects"
export PYTHONPATH="$here/upstream${PYTHONPATH:+:$PYTHONPATH}"
export PATH="$here/.venv/bin:$here/.ffmpeg/bin:$PATH"
exec "$here/.venv/bin/python" "$here/server.py"
