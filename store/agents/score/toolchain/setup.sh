#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$HERE/node.sh" --version
SCORE_LILYPOND=${LILYPOND_BIN:-lilypond}
if ! command -v "$SCORE_LILYPOND" >/dev/null 2>&1; then
  printf '%s\n' 'Score needs LilyPond for engraving. Install it from https://lilypond.org/download.html, or set LILYPOND_BIN to its executable. No musical instruments are needed.' >&2
  exit 1
fi
"$SCORE_LILYPOND" --version
