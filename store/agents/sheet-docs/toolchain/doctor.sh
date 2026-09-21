#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$HERE/setup.sh"
echo "ok   Node + LibreOffice; build the source to verify document conversion"
