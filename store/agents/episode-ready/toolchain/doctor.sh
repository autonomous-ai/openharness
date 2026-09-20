#!/usr/bin/env bash
# One line per check, and exit 0 only when the harness can actually do its work.
set -uo pipefail
cd "$(dirname "$0")/.."
PKG="$PWD"
# shellcheck source=../VERSIONS
. ./VERSIONS

CONDA="$PKG/toolchain/.conda"
VENV="$PKG/toolchain/.venv"
UPSTREAM="$PKG/upstream"
fail=0
miss() { echo "miss $1"; fail=1; }

# ffmpeg, and the four things we actually ask of it
if [ -x "$CONDA/bin/ffmpeg" ]; then
  have="$("$CONDA/bin/ffmpeg" -version 2>/dev/null | head -1 | awk '{print $3}')"
  if [ "$have" = "$FFMPEG_VERSION" ]; then echo "ok   ffmpeg $have"
  else miss "ffmpeg $FFMPEG_VERSION — toolchain/.conda has $have; run toolchain/setup.sh"; fi
  for want in libmp3lame:encoder aac:encoder; do
    n="${want%%:*}"
    "$CONDA/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q " $n " \
      && echo "ok   $n encoder" || miss "the $n encoder — run toolchain/setup.sh"
  done
  for n in loudnorm ebur128 silencedetect afftdn alimiter sidechaincompress; do
    "$CONDA/bin/ffmpeg" -hide_banner -h "filter=$n" >/dev/null 2>&1 \
      && echo "ok   $n filter" || miss "the $n filter — run toolchain/setup.sh"
  done
else
  miss "ffmpeg $FFMPEG_VERSION — run toolchain/setup.sh"
fi
[ -x "$CONDA/bin/ffprobe" ] && echo "ok   ffprobe" || miss "ffprobe — run toolchain/setup.sh"

# python and the transcriber, imported rather than looked at
if [ -x "$VENV/bin/python" ]; then
  echo "ok   $("$VENV/bin/python" --version 2>&1)"
  "$VENV/bin/python" -c "
import importlib.metadata as m
fw, ct = m.version('faster-whisper'), m.version('ctranslate2')
assert fw == '$FASTER_WHISPER_VERSION', fw
assert ct == '$CTRANSLATE2_VERSION', ct
import faster_whisper  # the import itself is the check
print('ok   faster-whisper', fw, '/ CTranslate2', ct)
" 2>/dev/null || miss "faster-whisper $FASTER_WHISPER_VERSION — run toolchain/setup.sh"
else
  miss "the Python environment — run toolchain/setup.sh"
fi

# the model
if [ -f "$UPSTREAM/models/$WHISPER_DEFAULT_MODEL/model.bin" ]; then
  echo "ok   Whisper $WHISPER_DEFAULT_MODEL weights ($(du -m "$UPSTREAM/models/$WHISPER_DEFAULT_MODEL" | tail -1 | cut -f1) MB)"
else
  miss "the Whisper $WHISPER_DEFAULT_MODEL weights — run toolchain/setup.sh"
fi

# the toolchain's own code, end to end on two seconds of tone
if [ "$fail" = 0 ]; then
  "$PKG/toolchain/ep" selftest >/dev/null 2>&1 \
    && echo "ok   the episode toolchain runs end to end" \
    || miss "the episode toolchain failed its self-test — run toolchain/ep selftest to see why"
fi

# the demo is a nicety, never a reason to be unready
if ls "$UPSTREAM"/demo/dist/*.mp3 >/dev/null 2>&1; then
  echo "ok   the demo episode a new workspace opens on"
else
  echo "ok   no demo episode (the fetch was skipped or failed); a new workspace opens empty and asks for your recording"
fi

exit $fail
