#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/env.sh"
exec "$OPENMONTAGE_PACKAGE/.venv/bin/python" "$here/init_workspace.py"
