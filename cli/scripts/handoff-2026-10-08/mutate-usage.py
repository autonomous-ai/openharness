"""Break real usage contributions; the unchanged former-code golden must reject each by assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
mutations = [
    ('service result', 'src/services/agentUsage.ts', 'value: usageSnapshot(value)', 'value: null'),
    ('session target', 'src/services/agentUsage.ts', 'cache.read(target)', "cache.read({ ...target, sessionId: 'miswired-conversation' })"),
    ('fork cutoff', 'src/lib/agentUsageWire.ts', 'forkedFrom: s.forkedFrom ?', 'forkedFrom: false && s.forkedFrom ?'),
    ('output snapshot', 'src/lib/agentUsageWire.ts', '...(v.output ? { output:', '...(false && v.output ? { output:'),
    ('work snapshot', 'src/lib/agentUsageWire.ts', '...(v.work ? { work:', '...(false && v.work ? { work:'),
    ('token snapshot', 'src/lib/agentUsageWire.ts', 'totalTokens: v.totalTokens, updatedAt:', 'totalTokens: null, updatedAt:'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('RECORD_USAGE_SHAPES', None)
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
for name, file, before, after in mutations:
    path = cli / file
    original = path.read_text()
    assert original.count(before) == 1, name
    path.write_text(original.replace(before, after))
    try:
        result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/lib/usageShapes.golden.spec.ts', '--maxWorkers=1'],
                                cwd=cli, env=env, text=True, capture_output=True, timeout=90)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError:' not in output or 'usageShapes.golden.spec.ts:' not in output:
            print(output[-6000:])
            raise SystemExit(f'{name}: not rejected by the golden assertion')
        print(f'{name}: caught by unchanged golden', flush=True)
    finally:
        path.write_text(original)
