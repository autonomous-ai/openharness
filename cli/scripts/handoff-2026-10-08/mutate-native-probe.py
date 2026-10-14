"""Owned-worktree wiring checks for the shared native probe and immutable helper."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/lib/nativeProcessControl.golden.spec.ts'
injected = 'src/lib/nativeProcessControlProbe.spec.ts'
owner = 'src/engines/kit/nativeHookOwner.golden.spec.ts'
mutations = [
    ('identity-only caller reads descriptors', 'src/lib/nativeProcessControl.ts',
     'probeNativeProcessControl(pids, parent, budget, descriptors,', 'probeNativeProcessControl(pids, parent, budget, true,', golden),
    ('daemon helper disconnected', 'src/lib/nativeProcessControl.ts',
     'prepare: () => bundledProcessImageHelper({ retryUnavailable: true })', 'prepare: async () => null', golden),
    ('precise native birth rounded', 'src/lib/nativeProcessControlProbe.ts',
     'birth: `${row.startSeconds}:${row.startMicros}`', 'birth: `${row.startSeconds}:0`', golden),
    ('native identity mode disconnected', 'src/lib/nativeProcessControlProbe.ts',
     "descriptors ? '--control' : '--identity'", "'--control'", golden),
    ('existing corrupt helper accepted', 'src/lib/nativeProcessImageArtifact.ts',
     'try { await lstat(target); return null }', 'try { await lstat(target); return target }', golden),
    ('wrong helper invalidated', 'src/lib/nativeProcessControlProbe.ts',
     'helpers.invalidate(helper.key)', "helpers.invalidate('different-helper')", injected),
    ('kernel boot reader disconnected', 'src/engines/kit/nativeHookOwner.ts',
     'boot ??= await kernelBootId(budget)', "boot ??= 'linux:fixture-boot'", owner),
    ('registry executable proof disconnected', 'src/engines/kit/nativeHookOwner.ts',
     'budget, undefined, row.processIdentity!', 'budget, undefined, undefined', owner),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(targets):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *targets, '--maxWorkers=1'],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=60)


baseline = run([golden, injected, owner])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Unchanged golden and pure dependency baselines passed', flush=True)
failures = []
for label, relative, before, after, target in mutations:
    source = cli / relative
    original = source.read_text()
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
