"""Every disconnected writer/local-root guard must fail an assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
writer = 'src/engines/kit/nativeHookWriter.ts'
scope = 'src/engines/kit/nativeHookScope.ts'
staging = 'src/engines/kit/nativeHookStaging.ts'
mutations = [
    ('noncanonical birth accepted', writer, ' && String(value) === text', '', 'holds noncanonical'),
    ('foreign PID namespace accepted', writer, 'if (before.namespace !== writer.namespace)', 'if (false)', 'holds a foreign PID namespace'),
    ('unconfirmed reboot accepted', writer,
     'if (before.boot !== writer.boot) { await confirm(root, before, budget, helpers); return true }',
     'if (before.boot !== writer.boot) return true', 'holds a changing'),
    ('changed root scope accepted', writer, ' || before.storage !== after.storage', '', 'holds a changing storage'),
    ('network storage accepted', scope, 'if (!localLinux.has(volume.type))', 'if (false)', 'rejects network, FUSE'),
    ('ancestor proc mount accepted', scope, "for (const key of ['NStgid', 'NSpid'])", 'for (const key of [])', 'holds an ambiguous'),
    ('changed mount accepted', scope, '    verifyNativePathFacts(facts)', '', 'retains positive local filesystem'),
    ('closed proof remains usable', scope, "    if (closed) unavailable('was closed')", '', 'synchronously revokes a closed proof'),
    ('writer admission skips local root', staging, '    verifyWriter(root)\n', '', 'network-view writer'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                           'src/engines/kit/nativeHookWriter.spec.ts',
                           'src/engines/kit/nativeHookScope.spec.ts',
                           'src/engines/kit/nativeHookStaging.spec.ts', '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


baseline = run()
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Writer/local-root baseline passed', flush=True)
failed = []
for label, relative, before, after, pattern in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failed.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failed:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failed))
