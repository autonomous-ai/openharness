#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'miss This harness targets Apple Silicon macOS.' >&2
  exit 1
fi
. toolchain/node.sh
if [ ! -x .venv/bin/python ]; then
  mlx_python=''
  for candidate in /opt/homebrew/opt/python@3.12/bin/python3.12 /opt/homebrew/opt/python@3.13/bin/python3.13 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [ -x "$candidate" ] && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1; then mlx_python="$candidate"; break; fi
  done
  if [ -z "$mlx_python" ]; then echo 'miss Python 3.10+ for Apple Silicon is required for setup.' >&2; exit 1; fi
  "$mlx_python" -m venv .venv
fi
if [ -x /opt/homebrew/bin/uv ]; then
  /opt/homebrew/bin/uv pip sync --python .venv/bin/python requirements.lock
else
  .venv/bin/python -m pip install -r requirements.lock
fi
exec ./toolchain/doctor.sh
