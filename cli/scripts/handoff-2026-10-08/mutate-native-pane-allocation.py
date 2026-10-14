"""Queued Stop must never acquire a pane after the native wrapper releases it."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
allocation = 'src/lib/nativePaneAllocation.ts'
spec = 'src/lib/nativePaneAllocation.spec.ts'
launch = 'src/lib/engineLaunch.ts'
process_spec = 'src/engines/kit/nativeRearmWitness.process.spec.ts'
mutations = [
    ('queued close ignores released ownership', allocation, [("const owns = all(original, equal(NATIVE_PANE_ALLOCATION_OPTION, active))", 'const owns = original')], spec, 'queued close after fallback'),
    ('claim overwrites a successor or released marker', allocation, [("either(equal(NATIVE_PANE_ALLOCATION_OPTION, ''), equal(NATIVE_PANE_ALLOCATION_OPTION, active))", "'1'")], spec, 'queued close after fallback|delayed release cannot revoke'),
    ('old prefix overrides changed daemon owner', allocation, [("equal(HARNESS_OWNER_OPTION, owner), either(starts(prefix), starts(tagged))", "either(equal(HARNESS_OWNER_OPTION, owner), starts(tagged)), either(starts(prefix), starts(tagged))")], spec, 'changed daemon owner'),
    ('stale marker overrides replacement root', allocation, [("equal('pane_id', pane), equal('pane_pid', pid),", "equal('pane_id', pane),")], spec, 'stale active marker'),
    ('marker overrides missing token prefix', allocation, [("equal(HARNESS_OWNER_OPTION, owner), either(starts(prefix), starts(tagged))", "equal(HARNESS_OWNER_OPTION, owner)")], spec, 'without the original token prefix'),
    ('release leaves the active marker', allocation, [("const value = operation === 'claim' ? active : released", 'const value = active')], spec, 'queued close after fallback'),
    ('missing acknowledgement starts engine or shell', allocation, [("if(reply.trim()!==${JSON.stringify(`native-allocation-${operation}`)})process.exit(1);", '')], spec, 'published .*lost reply'),
    ('release client can stall past its deadline', allocation, [("timeout:2000,killSignal:'SIGKILL',", '')], spec, 'uncertain stalled-release'),
    ('fallback skips ownership revocation', launch, [("    + beforeFallback", '')], spec, 'queued close after fallback'),
    ('native wrapper skips pre-exec claim', launch, [("${guard}${allocation('claim')}${engineRunScript", "${guard}${engineRunScript")], process_spec, 'top-level wrapper'),
    ('native wrapper skips fallback release', launch, [("tmuxBinary, allocation('release'))", "tmuxBinary)")], process_spec, 'exited witness'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=240)


result = run([spec, process_spec])
if result.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native pane allocation baselines passed', flush=True)
failures = []
for label, path, changes, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    changed = original
    for before, after in changes:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        source.write_text(changed)
        result = run([spec], pattern)
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
print(f'All {len(mutations)} native pane allocation faults caught by assertions', flush=True)
