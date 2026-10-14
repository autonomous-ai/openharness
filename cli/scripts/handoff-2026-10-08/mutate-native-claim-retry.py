"""A live publisher may confirm an undelivered claim, never borrow execution."""
import os
from pathlib import Path
import re
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_HOOK_MUTATIONS_OWNED') == '1'
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ('TMUX', 'TMUX_PANE') or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir()
journal = 'src/engines/kit/nativeHookJournal.ts'
spec = 'src/engines/kit/nativeHookJournal.spec.ts'
queue = 'src/core/engines/pendingAdmission.ts'
mutations = [
    ('undelivered publication forgotten', journal, 'retained.verify = verify', '', spec, 'never-delivered claim'),
    ('equal replacement borrows publication', journal, 'proofs.push(proof.verify)', 'void proof', spec, 'undelivered claim after its'),
    ('returned capability handed out again', journal, 'undelivered = undefined\n      return result', 'return result', spec, 'never-delivered claim'),
    ('concurrent retries share execution', journal,
     "if (claiming) held('the original claim confirmation is still settling')", '', spec, 'never-delivered claim'),
    ('public timeout abandons actual cleanup', journal, '(!attempt.actual || attempt.settled)', 'true', spec, 'timed-out actual'),
    ('late cleanup borrows public deadline', journal, 'confirmDeadline()\n    return result', 'return result', spec, 'cleanup crosses the absolute deadline'),
    ('late final proof borrows public deadline', journal, 'attempt.confirmDeadline!()', '', spec, 'final proof crosses the absolute deadline'),
    ('pending slot overrides accepted binding', queue, 'const owned = job.request.ownsEffect?.()',
     'const owned = job.request.ownsEffect?.() || job.request.pendingClaim?.()',
     'src/core/engines/pendingAdmission.spec.ts', 'undelivered exclusive claim'),
    ('pending slot server wiring omitted', 'src/hookServer.ts',
     'pendingClaim: () => context.journal.pendingClaim()?.id === deliveryId,', '',
     'src/lib/registry.admission.spec.ts', 'recovers an undelivered claim'),
]


def run(target, pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', target,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          capture_output=True, text=True, timeout=45)


for target in sorted({entry[4] for entry in mutations}):
    pattern = '|'.join(entry[5] for entry in mutations if entry[4] == target)
    result = run(target, pattern)
    output = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout + result.stderr)
    assert result.returncode == 0 and re.search(r'\bTests\s+[1-9]\d* passed\b', output), output
print('Undelivered claim baselines passed', flush=True)
failures = []
for label, relative, before, after, target, pattern in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        mutated = original.replace(before, after)
        if label == 'late cleanup borrows public deadline':
            # Both checks reject overdue cleanup. Remove both to prove the
            # absolute boundary, not survival through its redundant guard.
            mutated = mutated.replace('attempt.confirmDeadline!()', '')
        source.write_text(mutated)
        result = run(target, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
