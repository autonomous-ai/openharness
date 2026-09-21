#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
. ./VERSIONS
. ./runtimes.sh
harness_venv .venv 3.12 || exit 1
harness_pip .venv --require-hashes -r requirements.lock
if [ ! -d upstream/.git ]; then
  git init -q upstream
  git -C upstream remote add origin https://github.com/calesthio/OpenMontage.git
  git -C upstream sparse-checkout init --cone
  git -C upstream sparse-checkout set backlot lib schemas pipeline_defs styles
fi
if [ "$(git -C upstream rev-parse HEAD 2>/dev/null || true)" != "$OPENMONTAGE_COMMIT" ]; then
  git -C upstream fetch --depth 1 --filter=blob:none origin "$OPENMONTAGE_COMMIT"
  git -C upstream checkout --detach "$OPENMONTAGE_COMMIT"
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  harness_conda_env .ffmpeg 'ffmpeg=7.1.1' || exit 1
  export PATH="$PWD/.ffmpeg/bin:$PATH"
fi
# Preserve the resolved media tools when launched from the desktop's shorter PATH.
for tool in ffmpeg ffprobe; do
  resolved="$(command -v "$tool")"
  [ "$resolved" = "$PWD/.venv/bin/$tool" ] || ln -sf "$resolved" ".venv/bin/$tool"
done
exec ./doctor.sh
