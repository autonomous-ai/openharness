"""Owned disposable worktree only; unchanged baseline and assertion failures required."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
source = cli / 'hook/notify.mjs'
golden = 'src/hookNotify.transport.golden.spec.ts'
faults = 'src/hookNotify.transport.spec.ts'
mutations = [
    ('delivery ID disconnected', "'X-Harness-Hook-Delivery-Id': DELIVERY_ID,", '', golden),
    ('native time disconnected', "'X-Harness-Hook-Fired-At': String(FIRED_AT),", '', golden),
    ('UTF8 body size replaced by character count', "'Content-Length': Buffer.byteLength(payload)", "'Content-Length': payload.length", golden),
    ('pending Stop treated as completion', "if (reply.pending === true || reply.ignored === true) { finish('held'); return }", "if (reply.pending === true) { finish(true); return }; if (reply.ignored === true) { finish('held'); return }", golden),
    ('duplicate Stop completion forgotten', "if (path === '/api/hook/turn-stop' && reply.duplicate === true) { finish('duplicate'); return }", '', golden),
    ('connected reset allows registry fallback', "req.on('error', () => finish(connected ? 'late' : false))", "req.on('error', () => finish(false))", faults),
    ('HTTP refusal allows registry fallback', "if (!ok || !reply", "if (!ok) { finish(false); return }; if (!reply", faults),
    ('absolute request deadline disconnected', 'deadline = setTimeout(expire, timeout)', 'deadline = undefined', faults),
    ('expired request keeps receiving', 'req.destroy()', 'void 0', faults),
    ('response abort never settles', "res.on('aborted', () => finish('late'))", '', faults),
    ('response error never settles', "res.on('error', () => finish('late'))", '', faults),
    ('response close never settles', "res.on('close', () => finish('late'))", '', faults),
    ('error reply borrows success', "|| 'error' in reply", '', faults),
    ('mistyped acknowledgement accepted', "|| ['ok', 'pending', 'ignored', 'duplicate', 'retry'].some(key => key in reply && typeof reply[key] !== 'boolean')", '', faults),
    ('registration ignored reply completes Stop', "if (reply.pending === true || reply.ignored === true) { finish('held'); return }", "if (reply.ignored === true) { finish(true); return }; if (reply.pending === true) { finish('held'); return }", faults),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(targets):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *targets, '--maxWorkers=1'],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=60)


baseline = run([golden, faults])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Unchanged golden and fault baselines passed', flush=True)
original = source.read_text()
failures = []
for label, before, after, target in mutations:
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run([target])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
