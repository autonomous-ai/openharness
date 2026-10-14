"""The client may transfer only exact retained phases under its original owner."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
client = 'src/engines/kit/nativeHookClient.ts'
protocol = 'src/engines/kit/nativeHookClientProtocol.ts'
origin = 'src/engines/kit/nativeHookOrigin.ts'
journal = 'src/engines/kit/nativeHookJournal.ts'
spec = 'src/engines/kit/nativeHookClient.spec.ts'
origin_spec = 'src/engines/kit/nativeHookOrigin.spec.ts'
journal_spec = 'src/engines/kit/nativeHookJournal.spec.ts'
mutations = [
    ('input captured by reference', client,
     'const original = structuredClone(input)', 'const original = input', spec, 'retains both original phases'),
    ('unconfirmed registration lets Stop overtake', client,
     'if (!ack) break', 'if (!ack) continue', spec, 'does not acknowledge a legacy response'),
    ('every retained phase treated as owned', client,
     '.filter(phase => phase.acknowledged)', '', spec, 'retains both original phases'),
    ('retry replaces original native time', client,
     'firedAt: delivery.firedAt, body: phase.body', 'firedAt: Date.now(), body: phase.body', spec, 'retains both original phases'),
    ('legacy mutation route used', protocol,
     'return NATIVE_HOOK_ROUTE_PREFIX + name', "return '/api/hook/' + name", spec, 'old-core/new-core transition'),
    ('receipt endpoint ignored', protocol,
     'ack[key] === entry', "key === 'path' || ack[key] === entry", spec, 'another event endpoint'),
    ('receipt byte identity ignored', protocol,
     'ack[key] === entry', "key === 'bodySha256' || ack[key] === entry", spec, 'exact durable phase receipt'),
    ('deadline stops revoking publication', client,
     'const current = () => !expired && performance.now() < deadline', 'const current = () => true', spec, 'late transport receipt'),
    ('late opener escapes cleanup ownership', client,
     'storage = await deps.openStorage()\n      check()',
     'const opened = await deps.openStorage()\n      check(); storage = opened', spec, 'opener that finishes'),
    ('fresh caller identity discarded', client,
     'phase.body.nativeOrigin = origin', '', spec, 'retains both original phases'),
    ('original parent proof skipped', origin,
     '!before || before.parentPid !== callerPid', '!before', origin_spec, 'reused caller PID'),
    ('final self identity proof skipped', origin,
     '!after || controlIdentity(after) !== identity', 'false', origin_spec, 'while capturing the original prefix'),
    ('Cursor candidate captured after first self proof', origin,
     'const origin = await captureNativeHookOrigin(callerPid, budget, probe, candidate)',
     'const origin = await captureNativeHookOrigin(callerPid, budget, probe, runtime)', origin_spec, 'first client self proof'),
    ('discarded ancestor read never retried', journal,
     'attempt >= 2', 'attempt >= 0', journal_spec, 'enumeration invalidated by ancestor'),
    ('discarded read retry exceeds its limit', journal,
     'attempt >= 2', 'attempt >= 3', journal_spec, 'bounds discarded journal enumeration'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(target, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', target, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for target, pattern in [(spec, ''), (origin_spec, 'client|reused caller PID'),
                        (journal_spec, 'enumeration invalidated by ancestor|bounds discarded journal enumeration')]:
    baseline = run(target, pattern)
    if baseline.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native client baselines passed', flush=True)
failures = []
for label, relative, before, after, target, pattern in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(target, pattern)
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
