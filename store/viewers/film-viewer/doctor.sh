#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PYTHONPATH="$PWD/upstream" .venv/bin/python -c 'import fastapi, uvicorn, watchfiles, PIL; from backlot.state import load_board_state; print("ok   Film Viewer and Backlot production reader")'
test -x .venv/bin/ffmpeg && test -x .venv/bin/ffprobe || { echo 'miss FFmpeg and ffprobe; rerun setup.sh'; exit 1; }
echo 'ok   film decoding and thumbnails'
