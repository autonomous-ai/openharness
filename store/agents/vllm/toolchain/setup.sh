#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ] || [ "$(sw_vers -productVersion | cut -d. -f1)" -lt 15 ]; then
  echo 'miss vLLM Metal requires Apple Silicon and macOS 15+.' >&2
  exit 1
fi
. toolchain/node.sh
if [ ! -x .venv/bin/python ]; then
  vllm_python=/opt/homebrew/opt/python@3.12/bin/python3.12
  if [ ! -x "$vllm_python" ]; then echo 'miss Native arm64 Python 3.12 is required for these pinned wheels.' >&2; exit 1; fi
  "$vllm_python" -c 'import platform,sys; assert platform.machine()=="arm64" and sys.version_info[:2]==(3,12)'
  "$vllm_python" -m venv .venv
fi
if [ -x /opt/homebrew/bin/uv ]; then
  /opt/homebrew/bin/uv pip sync --python .venv/bin/python requirements.lock
else
  .venv/bin/python -m pip install -r requirements.lock
fi
exec ./toolchain/doctor.sh
