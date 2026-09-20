#!/usr/bin/env bash
# The pane. Harness runs this with HARNESS_VIEWER_PORT and HARNESS_WORKSPACE, through a login
# shell whose PATH may hold nothing we need: everything comes from inside the package.
set -euo pipefail
: "${HARNESS_VIEWER_PORT:?}" "${HARNESS_WORKSPACE:?}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
PY="$PKG/toolchain/.venv/bin/python"
[ -x "$PY" ] || { echo "miss the Python environment is not installed — run $PKG/toolchain/setup.sh" >&2; exit 1; }
export EPISODE_PACKAGE="$PKG"
export EPISODE_FFMPEG="$PKG/toolchain/.conda/bin/ffmpeg"
export EPISODE_FFPROBE="$PKG/toolchain/.conda/bin/ffprobe"
export PYTHONPATH="$HERE/lib${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
exec "$PY" -u "$HERE/viewer.py"
