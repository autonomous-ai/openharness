#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$HERE/setup.sh" || { echo "miss LilyPond — install from https://lilypond.org/download.html or set LILYPOND_BIN"; exit 1; }
echo "ok   LilyPond + Node; PDF/SVG engraving and MIDI playback available"
