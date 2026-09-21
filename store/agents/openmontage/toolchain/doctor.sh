#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
"$OPENMONTAGE_PACKAGE/.venv/bin/python" -c 'import PIL, yaml, pydantic, jsonschema; from lib.checkpoint import init_project; from tools.video.video_compose import VideoCompose; print("ok   OpenMontage workflow and Python runtime")'
command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null || { echo 'miss FFmpeg and ffprobe'; exit 1; }
test -f "$OPENMONTAGE_ROOT/AGENT_GUIDE.md" && test -f "$OPENMONTAGE_ROOT/remotion-composer/node_modules/remotion/package.json"
echo 'ok   Remotion, FFmpeg, and film production tools'
echo 'ok   local rendering needs no provider keys; cloud generation is optional'
