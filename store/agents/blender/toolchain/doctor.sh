#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."
if [ -x .venv/bin/python ] && .venv/bin/python -c 'import bpy' 2>/dev/null; then echo "ok   blender $(.venv/bin/python -c 'import bpy; print(bpy.app.version_string)')"; else echo "miss .venv with bpy — run toolchain/setup.sh"; exit 1; fi
if command -v ffmpeg >/dev/null 2>&1 || .venv/bin/python -c 'import imageio_ffmpeg; imageio_ffmpeg.get_ffmpeg_exe()' 2>/dev/null; then echo "ok   ffmpeg (turntables)"; else echo "warn no ffmpeg — turntables stay as frames until toolchain/setup.sh runs again"; fi
