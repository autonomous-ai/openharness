#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/node.sh
"$LOCAL_AI_NODE" -e 'console.log(`ok   Node ${process.versions.node}`)'
if [ ! -x .venv/bin/python ]; then echo 'miss MLX-LM environment — run toolchain/setup.sh' >&2; exit 1; fi
.venv/bin/python - <<'PY'
import importlib.metadata, platform
import mlx.core as mx
assert platform.system() == 'Darwin' and platform.machine() == 'arm64', 'Apple Silicon macOS is required'
assert mx.metal.is_available(), 'Metal is unavailable'
print('ok   MLX-LM', importlib.metadata.version('mlx-lm'))
print('ok   MLX', importlib.metadata.version('mlx'), '· Metal available')
print('ok   Local model worker · Hugging Face cache · no inference API key')
PY
