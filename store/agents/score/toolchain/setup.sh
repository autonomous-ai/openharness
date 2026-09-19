#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash "$HERE/node.sh" --version
if [ -n "${LILYPOND_BIN:-}" ]; then "$LILYPOND_BIN" --version; else lilypond --version; fi
