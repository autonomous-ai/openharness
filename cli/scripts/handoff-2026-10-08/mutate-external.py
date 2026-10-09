"""Prove the former external shape golden and new safety regressions cross real wiring.

Run with no tests or source edits in flight. Every mutation is restored, even on failure.
"""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/lib/sessionSearch/externalShapes.golden.spec.ts'
mutations = [
    ('owner observations dropped', 'src/services/externalSessions.ts',
     'const claim = claims.find(claim => !claim.fromArgs) ?? claims[0]', 'const claim = undefined', golden),
    ('busy observations dropped', 'src/services/externalSessions.ts',
     'busy: activity.value?.busy !== false', 'busy: false', golden),
    ('archived conversation admitted', 'src/core/agents/adopt.ts',
     'if (found.archived)', 'if (false)', golden),
    ('Hermes profile stripped at wire', 'src/lib/externalSessionWire.ts',
     '...(value.launchArgs ? { launchArgs: [...value.launchArgs as string[]] } : {})', '...{}', golden),
    ('canonical alias reservation dropped', 'src/core/agents/adopt.ts',
     '[found.sessionId, ...found.aliases ?? []].some(held)', '[found.sessionId].some(held)', golden),
    ('validated launch never dispatched', 'src/core/agents/externalResume.ts',
     '    deps.launch()', '    // disconnected launch wiring', 'src/core/agents/externalResume.spec.ts'),
    ('dispatch journal omitted', 'src/lib/restoreAgents.ts',
     'const committed = deps.registry.beginExternalDispatch?.(entry.agentId)',
     'const committed = deps.registry.byAgent(entry.agentId)', 'src/lib/restoreAgents.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
command = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']
baseline = subprocess.run([*command, *sorted({item[4] for item in mutations})], cwd=cli, env=env,
                          capture_output=True, text=True, timeout=90)
if baseline.returncode:
    sys.exit('Baseline did not pass; no mutations were run.\n' + baseline.stdout[-5000:] + baseline.stderr[-5000:])
for name, path, old, new, spec in mutations:
    target = cli / path
    source = target.read_text()
    assert source.count(old) == 1, (name, source.count(old))
    try:
        target.write_text(source.replace(old, new))
        result = subprocess.run([*command, spec], cwd=cli, env=env, capture_output=True, text=True, timeout=90)
        caught = result.returncode != 0 and 'AssertionError' in result.stdout + result.stderr
        print(f'{name}: {"caught by assertion" if caught else "NOT PROVEN"}', flush=True)
        if not caught:
            sys.exit(result.stdout[-5000:] + result.stderr[-5000:])
    finally:
        target.write_text(source)
