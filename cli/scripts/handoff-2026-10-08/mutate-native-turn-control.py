"""Native content and control must retain original ownership through every wait."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
control = 'src/core/turns/nativeTurnControl.ts'
spec = 'src/core/turns/nativeTurnControl.spec.ts'
mutations = [
    ('permits multiply actual reads', control, '    if (reading) {', '    if (false && reading) {',
     spec, 'bounds concurrent permit waits'),
    ('completed reads outlive the absolute deadline', control, 'if (now() >= deadline) throw expire()', '',
     spec, 'refuses late .* completion'),
    ('expired old permits revoke newer inspections', control, 'reading?.result === result && live()', 'live()',
     spec, 'expires only the old permit'),
    ('recovered cancellation can disappear', control, "if (view.selection === 'cancelled' && !cancelled)", 'if (false)',
     spec, 'does not let a new prompt'),
    ('already prepared permits ignore recovered Cancel', control, "if (cancelled) unavailable('Cancel holds this incarnation')", '',
     spec, 'revokes already granted permits'),
    ('delayed effects omit their original proof', control, '      state.verify()\n      if (cancelled)', '      if (cancelled)',
     spec, 'revokes a prepared generation effect after proof'),
    ('late responses decorate another generation', control, 'content.get(generation.id) ?? EMPTY_NATIVE_CONTENT', 'EMPTY_NATIVE_CONTENT',
     spec, 'recovers a completed generation quietly'),
    ('HTTP read and notification omit retained content', 'src/hookServer.ts',
     'source = Object.freeze({ ...retained, observations, recoveredFactIds: context.recoveredFactIds, verify })',
     'source = Object.freeze({ ...retained, observations: Object.freeze([]), recoveredFactIds: context.recoveredFactIds, verify })',
     'src/hookServer.nativeProtocol.spec.ts', 'retains the exact native response'),
    ('first live facts are treated as recovered', control, 'recovered: state.recovered,', 'recovered: true,',
     spec, 'does not hide the first live generation'),
    ('a late response repeats recovered completion', control, "ended: prior.some(fact => fact.kind === 'stopped' || fact.kind === 'cancelled')",
     'ended: false', spec, 'keeps a recovered Stop quiet'),
    ('first live starts are hidden', control, "started: prior.some(fact => fact.kind === 'activity' || fact.kind === 'stopped')",
     'started: true', spec, 'does not hide the first live generation'),
    ('HTTP recovery loses its fixed baseline', 'src/hookServer.ts',
     'observations, recoveredFactIds: context.recoveredFactIds, verify',
     'observations, recoveredFactIds: Object.freeze([]), verify',
     'src/hookServer.nativeProtocol.spec.ts', 'keeps an interrupted generation write pending'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(file, pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', file, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=95)


for file, pattern in [(spec, '.'), ('src/hookServer.nativeProtocol.spec.ts', 'retains the exact native response')]:
    baseline = run(file, pattern)
    if baseline.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native turn control and HTTP content baselines passed', flush=True)
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
