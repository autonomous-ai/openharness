#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$HERE/node.sh" "$HERE/../skills/score/scripts/lilypond.mjs" --check || exit 1
echo "ok   LilyPond + Node; PDF/SVG engraving and MIDI playback available"
