"""Native Cancel keeps original authority through storage, deadlines and pane dispatch."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
control = 'src/core/turns/nativeCancel.ts'
unit = 'src/core/turns/nativeCancel.spec.ts'
intent = 'src/lib/nativeTurnIntent.ts'
mutations = [
    ('Cancel leaves queued writer authority alive', control,
     '      revoke(original); writer.revoke(id)', '      revoke(original)', unit,
     'saves the immutable original cancellation'),
    ('journal runs before durable publication', control,
     'job.saved = structuredClone(registry.commitNativeControl(job.original, job.intent, () => current(job)))',
     'job.saved = structuredClone(job.original)', unit, 'saves the immutable original cancellation'),
    ('unknown owner gains physical authority', control,
     'if (processKey === null)', 'if (false)', unit, 'saves missing ownership'),
    ('recovered journal capability is replayed', control,
     'if (!result.recorded)', 'if (false)', unit, 'does not replay an earlier'),
    ('Cancel adopts a replacement process', control,
     ' || nativeTurnTarget(row) !== job.target', '', unit, 'when process changes'),
    ('consumed dispatch can retry', control,
     'if (dispatched || !original)', 'if (!original)', unit, 'rechecks its original proof after draining'),
    ('late Cancel overwrites a successor status', control,
     'if (original) hold(id,', 'if (!closed) hold(id,', unit, 'a new Cancel supersedes'),
    ('journal reads escape actual slot capacity', control,
     'running >= maxRunning', 'false', unit, 'retains actual journal occupancy'),
    ('late result renews the caller deadline', control,
     "      if (now() >= job.deadline) throw Error('the original interrupt deadline expired before confirmation')", '', unit,
     'does not report confirmation after its absolute deadline'),
    ('visible publication replaces fresh confirmation', control,
     '      registry.readNativeControl(job.saved).verify()', '', unit,
     'freshly confirms its exact visible publication'),
    ('rearm revocation discards uncertain allocation', intent,
     '      && same(next.rearm, { ...previous.rearm, revoked: true })', '',
     'src/lib/nativeTurnIntent.spec.ts', 'a new Cancel permanently revokes'),
    ('revocation preserves old interrupt ticket', 'src/core/terminals/writer.ts',
     ' && state.epoch === epoch', '', unit, 'checks writer at the final physical dispatch'),
    ('physical dispatch crosses the original deadline', control,
     "          if (now() >= job.deadline) throw Error('the original interrupt deadline expired')", '', unit,
     'starts the absolute interrupt deadline before capturing'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(file, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', file,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for file in dict.fromkeys(mutation[4] for mutation in mutations):
    result = run(file)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native Cancel baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == (2 if label in ['journal reads escape actual slot capacity', 'revocation preserves old interrupt ticket'] else 1), (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run(file, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
