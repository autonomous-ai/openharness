"""Owned disposable worktree only. Missing safety wiring must fail behavioral assertions."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_HISTORY_MUTATIONS_OWNED') == '1'
source = 'src/lib/purgeAgentService.ts'
evidence = 'src/lib/nativeHistoryEvidence.ts'
spec = 'src/lib/nativeHistoryAuthority.spec.ts'
deletion = 'src/lib/nativeHistoryDeletion.spec.ts'
golden = 'src/lib/nativeConsumers.golden.spec.ts'
mutations = [
    ('inspection loses native authority', source, [('const proof = nativeHistoryEvidence(engine, id, path, profile, cwd)',
      'const proof = { path, verify: (_key?: string) => {}, prepareWorkspaceRemoval: undefined }')], spec, 'before review'),
    ('deletion loses fresh native authority', source, [('history.verify?.()', 'void history'),
      ('history.verify?.(nativeFileKey(current))', 'void current')], spec, 'changed header on the same inode'),
    ('missing-file cleanup loses its fresh proof', source, [('const after = missing()', 'const after = before')], spec, 'missing-file cleanup'),
    ('missing-file cleanup accepts a new parent', source, [('after.key !== before.key', 'false')], spec, 'replaced parent directory'),
    ('Stop loses its admission proof', source, [('if (sessionData) review.history!.verify?.()\n      this.jobs.add',
      'this.jobs.add')], spec, 'evidence before Stop'),
    ('worktree deletion loses its post-Stop proof', source, [('if (sessionData) review.history!.verify?.()\n          if (worktreeData && !worktreeDeleted)',
      'if (worktreeData && !worktreeDeleted)')], spec, 'during Stop before worktree deletion'),
    ('recoverable evidence consumes the review', source, [('retainReview = true', 'retainReview = false')], spec, 'same reviewed retry'),
    ('healthy review drops its measured bytes', source, [('return { file: target, bytes: target.bytes, verify: proof.verify,',
      'return { file: target, bytes: 0, verify: proof.verify,')], golden, ''),
    ('final pathname borrows another inode authority', source, [('const current = nativeHistoryFile(history.file.path)',
      'const current = { ...file(history.file.path), verify: () => {} }'), ('current.path !== history.file.path || ', ''),
      ('unlinkSync(history.file.path)', 'unlinkSync(current.path)')], deletion, 'redirected only during realpath'),
    ('fixed unlink route loses its final proof', source, [('current.verify()', 'void current')], deletion,
      'reviewed alias moves between final acquisition'),
    ('final target read loses its typed hold', evidence, [("catch { return nativeUnavailable('the native conversation could not be inspected') }",
      "catch { throw Error('untyped native file failure') }")], deletion, 'one-shot final native-target'),
    ('final ownership fence disappears', source, [("if (identity(this.current(request, true)) !== savedIdentity) return fail('The saved harness changed while deleting its worktree. Its native history was kept.')",
      'void savedIdentity')], deletion, 'during the worktree await'),
    ('capacity evicts an unexpired confirmation', source, [("if (this.reviews.size >= 64) return fail('There are too many unexpired deletion reviews. Wait for one to finish or expire before reviewing another.')\n        const signature",
      'if (this.reviews.size >= 64) this.reviews.delete(this.reviews.keys().next().value!)\n        const signature')], deletion, 'at capacity'),
    ('Pi accepts changed external ancestry or aliases', evidence, [('files.verify(); removed.verifyAncestors()',
      'files.verify()')], deletion, 'changed ancestor|changed alias'),
    ('Pi accepts a recreated worktree root', evidence, [('after.workspaceKey !== null || files.locate(removed.path, true) || !files.paths.absentLeaf(removed.path)',
      'after.workspaceKey !== null')], deletion, 'recreated root'),
    ('Pi loses completed workspace removal authority', source, [('removedWorkspace?.()', 'void removedWorkspace')], deletion, 'deletes real Pi history'),
    ('held deletion replays a completed worktree stage', source, [('if (worktreeData && !worktreeDeleted)',
      'if (worktreeData)')], deletion, 'unavailable header and reports'),
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


baseline = run([spec, deletion, golden])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, edits, target, pattern in mutations:
    source_path = cli / relative
    original = source_path.read_text()
    changed = original
    for before, after in edits:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        source_path.write_text(changed)
        result = run([target], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source_path.write_text(original)
if failures:
    raise SystemExit('Uncaught mutations: ' + ', '.join(failures))
