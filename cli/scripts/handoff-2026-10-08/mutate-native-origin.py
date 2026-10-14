"""Immutable native origin checks; every broken wire must fail an assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
origin = 'src/engines/kit/nativeHookOrigin.ts'
http = 'src/lib/registry.admission.spec.ts'
pure = 'src/engines/kit/nativeHookOrigin.spec.ts'
owner = 'src/engines/kit/nativeHookOwner.spec.ts'
mutations = [
    ('retained origin discarded', 'src/hookServer.ts',
     'if (body.nativeOrigin !== undefined) {', 'if (false && body.nativeOrigin !== undefined) {', http, 'admits a retained client origin'),
    ('origin omitted from delivery fingerprint', 'src/hookServer.ts',
     'JSON.stringify([body, admissionOrder.firedAt])', 'JSON.stringify([{ ...body, nativeOrigin: undefined }, admissionOrder.firedAt])', http, 'admits a retained client origin'),
    ('fresh digest comparison removed', 'src/engines/kit/nativeHookOwner.ts',
     'original.identityV1 !== nativeHookIdentityV1(evidence)', 'false', owner, 'reproves a saved v1 digest'),
    ('changed ancestry edge skipped', origin,
     'if (!parent || child && (!rows.get(child.pid) || controlIdentity(rows.get(child.pid)!) !== controlIdentity(child))) break',
     'if (!parent) break', pure, 'never skips a changed child'),
    ('Cursor route fence removed', origin,
     '&& runtime.routeV1 === nativeHookRouteV1(row)', '', pure, 'unique original Cursor route'),
    ('unknown origin version accepted', origin,
     'input.version !== 1', 'false', pure, 'unsupported version'),
    ('caller-owned origin remains mutable', origin,
     'return structuredClone(input) as unknown as NativeHookOrigin', 'return input as unknown as NativeHookOrigin', pure, 'serializable'),
    ('identity hashed after truncation', origin,
     'update(JSON.stringify([value[0], value[1], value[2], value[3], value[4], value[5], value[6]]))',
     'update(JSON.stringify([value[0], value[1], value[2], value[3], value[4], value[5], value[6]]).slice(0, 64))', pure, 'pins the v1 identity'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(target, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', target, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=45)


for target, pattern in [(pure, ''), (owner, 'reproves a saved v1 digest'),
                        (http, 'admits a retained client origin|retained origin without fresh|reproves a client origin')]:
    baseline = run(target, pattern)
    if baseline.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native origin baselines passed', flush=True)
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
