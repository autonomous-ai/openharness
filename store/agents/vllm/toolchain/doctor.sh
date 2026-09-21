#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
. toolchain/node.sh
"$LOCAL_AI_NODE" -e 'console.log(`ok   Node ${process.versions.node}`)'
if [ ! -x .venv/bin/python ]; then echo 'miss vLLM environment — run toolchain/setup.sh' >&2; exit 1; fi
VLLM_NO_USAGE_STATS=1 .venv/bin/python - <<'PY'
import importlib.metadata, platform, sys
import mlx.core as mx
from vllm.platforms import current_platform
from vllm_metal.platform import MetalPlatform
from vllm_metal.metal import get_ops
assert platform.machine() == 'arm64' and sys.version_info[:2] == (3, 12), 'Native arm64 Python 3.12 required'
assert isinstance(current_platform, MetalPlatform), 'vLLM did not select Metal'
assert mx.metal.is_available(), 'Metal is unavailable'
key = mx.ones((1, 1, 64), dtype=mx.float16)
value = key * 2
kc = mx.zeros((1, 16, 1, 64), dtype=mx.float16)
vc = mx.zeros_like(kc)
kc, vc = get_ops().reshape_and_cache(key, value, kc, vc, mx.array([3], dtype=mx.int64))
mx.eval(kc, vc)
assert mx.sum(kc).item() == 64 and mx.sum(vc).item() == 128, 'Native Metal cache kernel failed'
for name in ['vllm', 'vllm-metal', 'mlx', 'mlx-lm']:
    print('ok  ', name, importlib.metadata.version(name))
print('ok   Metal selected · native paged-attention cache kernel passed')
PY
