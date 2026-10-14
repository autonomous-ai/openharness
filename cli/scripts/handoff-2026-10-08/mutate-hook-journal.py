"""Prove process-isolated journal regressions reject broken ownership wiring."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
source = cli / 'src/engines/kit/nativeHookJournal.ts'
mutations = [
    ('uncertain effect claim can be acquired again',
     "if (before.active) held('an earlier native hook effect is unconfirmed')", '',
     'holds an unconfirmed claim'),
    ('cross-process intake frontier ignored',
     "if (inspected && inspected.previous !== before.previous) held('native hook order changed after inspection')", '',
     'equal-time delivery'),
    ('completed delivery can dispatch again',
     'if (!delivery || delivery.result || delivery.intake.agentId !== agentId)',
     'if (!delivery || delivery.intake.agentId !== agentId)', 'completed receipt'),
    ('changed retry accepted after process exit',
     "known.intake.fingerprint !== intake.fingerprint", 'false',
     'completed receipt'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern='', spec='nativeHookJournal.process.spec.ts'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                           'src/engines/kit/' + spec, '--maxWorkers=1',
                           *(['--testNamePattern', pattern] if pattern else [])],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=100)


baseline = run()
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('All OS-process baselines passed', flush=True)
original = source.read_text()
failures = []
for label, before, after, pattern in mutations:
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
try:
    before = 'identity: exclusive ? undefined : `native-hook-confirm:${digest(text)}`,'
    assert original.count(before) == 1
    source.write_text(original.replace(before, ''))
    result = run('joins identical immutable confirmations', 'nativeHookJournal.spec.ts')
    output = result.stdout + result.stderr
    if result.returncode == 0 or 'AssertionError' not in output:
        failures.append('identical confirmation cannot join')
        print('identical confirmation cannot join: not caught by an assertion\n' + output, flush=True)
    else:
        print('identical confirmation cannot join: caught by assertion', flush=True)
finally:
    source.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
