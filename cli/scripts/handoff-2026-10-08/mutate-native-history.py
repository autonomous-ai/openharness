"""Owned disposable worktree only. Missing safety wiring must fail behavioral assertions."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_HISTORY_MUTATIONS_OWNED') == '1'
source = cli / 'src/lib/purgeAgentService.ts'
spec = 'src/lib/nativeHistoryAuthority.spec.ts'
golden = 'src/lib/nativeConsumers.golden.spec.ts'
mutations = [
    ('inspection loses native authority', [('const proof = controlTranscriptEvidence(engine, id, path, profile, cwd)',
      'const proof = { path, verify: (_key?: string) => {} }')], spec, 'before review'),
    ('deletion loses fresh native authority', [('history.verify?.()', 'void history'),
      ('history.verify?.(nativeFileKey(current))', 'void current')], spec, 'changed header on the same inode'),
    ('missing-file cleanup loses its fresh proof', [('const after = missing()', 'const after = before')], spec, 'missing-file cleanup'),
    ('missing-file cleanup accepts a new parent', [('after.key !== before.key', 'false')], spec, 'replaced parent directory'),
    ('Stop loses its admission proof', [('if (sessionData) review.history!.verify?.()\n      this.jobs.add',
      'this.jobs.add')], spec, 'evidence before Stop'),
    ('worktree deletion loses its post-Stop proof', [('if (sessionData) review.history!.verify?.()\n          if (worktreeData)',
      'if (worktreeData)')], spec, 'during Stop before worktree deletion'),
    ('recoverable evidence consumes the review', [('retainReview = true', 'retainReview = false')], spec, 'same reviewed retry'),
    ('healthy review drops its measured bytes', [('return { file: target, bytes: target.bytes, verify: proof.verify }',
      'return { file: target, bytes: 0, verify: proof.verify }')], golden, ''),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(files, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=120)


baseline = run([spec, golden])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
original = source.read_text()
failures = []
for label, edits, target, pattern in mutations:
    changed = original
    for before, after in edits:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        source.write_text(changed)
        result = run([target], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Uncaught mutations: ' + ', '.join(failures))
