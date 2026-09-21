#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$HERE/node.sh" "$HERE/../skills/score/scripts/lilypond.mjs" --install
