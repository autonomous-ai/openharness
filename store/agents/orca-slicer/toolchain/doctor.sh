#!/bin/sh
set -u
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec bash "$here/setup.sh"
