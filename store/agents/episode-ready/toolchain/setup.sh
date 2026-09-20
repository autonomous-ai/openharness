#!/usr/bin/env bash
# Episode Ready — everything this harness needs, pinned, inside this package.
# Runs once at install, in the package directory. Nothing touches the machine's Python, Homebrew
# or PATH: ffmpeg comes from conda-forge, the interpreter from uv, both through runtimes.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
PKG="$PWD"
# shellcheck source=runtimes.sh
. toolchain/runtimes.sh
# shellcheck source=../VERSIONS
. ./VERSIONS

CONDA="$PKG/toolchain/.conda"
VENV="$PKG/toolchain/.venv"
UPSTREAM="$PKG/upstream"
mkdir -p "$UPSTREAM/models" "$UPSTREAM/media"

# ---------------------------------------------------------------- ffmpeg (+ lame, aac, opus)
if [ -x "$CONDA/bin/ffmpeg" ] && "$CONDA/bin/ffmpeg" -version 2>/dev/null | head -1 | grep -q "version $FFMPEG_VERSION"; then
  echo "ok   ffmpeg $FFMPEG_VERSION already in toolchain/.conda"
else
  echo "     conda-forge ffmpeg $FFMPEG_VERSION into toolchain/.conda (about 400 MB; it brings LAME, AAC, Opus and FLAC)"
  rm -rf "$CONDA.partial"
  harness_conda_env "$CONDA.partial" "$FFMPEG_SPEC" || { echo "miss ffmpeg $FFMPEG_VERSION could not be installed from conda-forge — check this machine's internet connection, then run toolchain/setup.sh again"; exit 1; }
  rm -rf "$CONDA"; mv "$CONDA.partial" "$CONDA"
  echo "ok   $("$CONDA/bin/ffmpeg" -version | head -1 | cut -d' ' -f1-3)"
fi
for enc in libmp3lame aac; do
  "$CONDA/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q " $enc " \
    || { echo "miss the ffmpeg build in toolchain/.conda has no $enc encoder — delete toolchain/.conda and run toolchain/setup.sh again"; exit 1; }
done

# ---------------------------------------------------------------- python + transcription
harness_venv "$VENV" "$PYTHON_VERSION" || exit 1
if ! "$VENV/bin/python" -c "
import importlib.metadata as m, sys
sys.exit(0 if m.version('faster-whisper') == '$FASTER_WHISPER_VERSION' and m.version('ctranslate2') == '$CTRANSLATE2_VERSION' else 1)
" 2>/dev/null; then
  echo "     faster-whisper $FASTER_WHISPER_VERSION and CTranslate2 $CTRANSLATE2_VERSION into toolchain/.venv (about 190 MB)"
  harness_pip "$VENV" "faster-whisper==$FASTER_WHISPER_VERSION" "ctranslate2==$CTRANSLATE2_VERSION" || exit 1
fi
echo "ok   faster-whisper $FASTER_WHISPER_VERSION, CTranslate2 $CTRANSLATE2_VERSION"

# ---------------------------------------------------------------- the model, pinned by commit
default_var="WHISPER_MODEL_$(printf '%s' "$WHISPER_DEFAULT_MODEL" | tr '.-' '__')"
eval "default_ref=\${$default_var}"
if ! HF_HUB_DISABLE_TELEMETRY=1 "$VENV/bin/python" "$PKG/toolchain/lib/fetch_model.py" "$WHISPER_DEFAULT_MODEL" "$default_ref" "$UPSTREAM/models"; then
  echo "miss the Whisper $WHISPER_DEFAULT_MODEL weights could not be fetched from Hugging Face — check this machine's internet connection, then run toolchain/setup.sh again"
  exit 1
fi

# Pay the first-run cost here: load the model once so the first transcription is not a cold start.
"$VENV/bin/python" - "$UPSTREAM/models/$WHISPER_DEFAULT_MODEL" <<'PY' || { echo "miss the Whisper model in upstream/models will not load — delete it and run toolchain/setup.sh again"; exit 1; }
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print("ok   the model loads")
PY

# ---------------------------------------------------------------- the recording the pane opens on
DEMO_SRC="$UPSTREAM/media/demo-source.mp3"
if [ -f "$DEMO_SRC" ] && [ "$(_harness_sha256 "$DEMO_SRC")" = "$DEMO_SHA256" ]; then
  echo "ok   the demo recording is already here"
else
  echo "     the public-domain recording the workspace opens on (1.9 MB, LibriVox)"
  _harness_fetch "$DEMO_URL" "$DEMO_SRC" "$DEMO_SHA256" || {
    echo "miss the demo recording could not be fetched — the harness still works; a new workspace will open empty and ask for your recording"
    rm -f "$DEMO_SRC"
  }
fi

# ---------------------------------------------------------------- produce the demo episode once
if [ -f "$DEMO_SRC" ]; then
  if [ -f "$UPSTREAM/demo/episode.json" ] && ls "$UPSTREAM"/demo/dist/*.mp3 >/dev/null 2>&1; then
    echo "ok   the demo episode is already produced"
  else
    echo "     producing the demo episode once, so a new workspace opens on real work (about a minute)"
    rm -rf "$UPSTREAM/demo"
    if "$PKG/toolchain/ep" demo-build "$DEMO_SRC" "$UPSTREAM/demo"; then
      echo "ok   the demo episode is produced"
    else
      echo "miss the demo episode would not build — the harness still works; a new workspace will open empty"
      rm -rf "$UPSTREAM/demo"
    fi
  fi
fi

echo "ok   Episode Ready is installed"
