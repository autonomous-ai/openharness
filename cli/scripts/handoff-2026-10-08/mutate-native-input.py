"""Native input must keep original authority without replaying uncertain writes."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
core = 'src/core/input.ts'
native = 'src/core/turns/nativeInput.ts'
writer = 'src/core/terminals/writer.ts'
composition = 'src/core/input.spec.ts'
mutations = [
    ('sender revocation ignored', core,
     "canWrite: id => !id.startsWith('team:') || deps.deliveries.canWrite(id)", 'canWrite: () => true',
     composition, 'rechecks a teammate'),
    ('multiline human draft overwritten', core, ': screen.teamHold), write, true)', ': null), write, true)',
     composition, 'preserves a human multiline draft'),
    ('unreadable composer permits Enter', core, 'screen.teamHold), write, true)', 'screen.teamHold), write, false)',
     'src/core/terminals/writeComposition.spec.ts', 'holds the real native tmux Enter'),
    ('native proof dropped before dispatch', native, '          permit.verify()', '',
     'src/core/turns/nativeInput.spec.ts', 'rechecks the native proof'),
    ('ambiguous paste replayed', native, 'item.dispatched = true;', '',
     'src/core/turns/nativeInput.spec.ts', 'uncertain physical dispatch: partial refusal'),
    ('interrupted epoch silently renewed', native, 'item.authority ??= reserve(id)', 'item.authority = reserve(id)',
     'src/core/turns/nativeInput.spec.ts', 'never renews a writer epoch'),
    ('individual cancellation left behind worker', core,
     'deviceInput.legacyWrite(id, operation, write, signal)', 'deviceInput.legacyWrite(id, operation, write)',
     composition, 'cancels input stalled in a screen reader'),
    ('individual cancellation left behind device', 'src/core/deviceInput.ts',
     "signal?.addEventListener('abort', abort, { once: true })", '',
     'src/core/deviceInput.spec.ts', 'cancels a legacy write waiting behind a device'),
    ('held epoch evicted between attempts', writer, ' || old.reservations', '',
     'src/core/turns/nativeInput.spec.ts', 'acquires capacity when it returns'),
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
print('Native input baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
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
