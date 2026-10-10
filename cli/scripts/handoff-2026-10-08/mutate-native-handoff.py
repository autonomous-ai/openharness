"""Owned disposable worktree only. Broken handoff wiring must fail behavioral assertions."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_HANDOFF_MUTATIONS_OWNED') == '1'
core = 'src/core/handoffPublication.ts'
publish = 'src/lib/handoffPublication.ts'
native = 'src/core/handoffPublication.native.spec.ts'
transaction = 'src/core/handoffPublication.spec.ts'
golden = 'src/lib/nativeHandoff.golden.spec.ts'
process = 'src/services/handoffProcess.spec.ts'
reader = 'src/lib/transcriptReader.spec.ts'
native_fence = '''          const proof = controlTranscriptEvidence(read.engine, read.sessionId, read.path, read.profile, read.cwd)
          const current = new NativeFiles(); current.locate(read.path)
          const file = current.file(proof.path)!
          if (file.path !== read.readPath || nativeFileKey(file.info) !== read.fileKey
            || !reserved && nativeContentVersion(file.info) !== read.version) return hold()
          current.verify(read.path); proof.verify(read.fileKey); verifyNativePathFacts(read.route)
          if (!same(current.paths.snapshot(), read.route)) return hold()
          verifyHandoffVersion(read, reserved ? nativeContentVersion(file.info) : read.version)'''
mutations = [
    ('healthy composition loses its published result', publish, [
        ('confirmed(); guards(); fence(); receipt.committed = true; save(); await durable()\n    return prepared.result',
         'confirmed(); guards(); fence(); receipt.committed = true; save(); await durable()\n    return { ...prepared.result, file: null }', 1)], golden, ''),
    ('current session fingerprint is ignored', core, [
        (' || handoffSessionFact(current).fingerprint !== session.fingerprint', '', 1)], native, 'binding changes|runtime changes'),
    ('core native authority is disconnected', core, [(native_fence, '          void read', 1)], native, 'altered native key'),
    ('core by-ID selection is disconnected', core, [
        (' || (index > 0 || owner.sessionId) && read.path !== selectedPath', '', 1)], native, 'without the current core selection'),
    ('current parent link is ignored', core, [
        ('link.agentId !== owner.agentId\n              || ', '', 1)], native, 'wrong parent ancestry'),
    ('an incomplete fork becomes empty history', core, [
        ('if (last.forkedFrom && !facts.reads.some(read => read.ownerAgentId === last.agentId)) return hold()', 'void last', 1)], native, 'altered missing fork chain'),
    ('publication locks are removed', publish, [
        ("if (keys.some(key => publications.has(key))) throw new HandoffError('BUSY')", 'void keys', 1)], transaction, 'serializes publication'),
    ('expiry after synchronous I/O is ignored', publish, [('checkRequest()', 'void 0', 6)], transaction, 'expires during a synchronous'),
    ('completed ignore content is not confirmed', publish, [
        (" || currentIgnore.text !== '*\\n'", '', 1)], transaction, 'completed publication when ignore changed'),
    ('completed exclusion content is not confirmed', publish, [
        ('if (current.text !== exclusion.after) return held()', 'void current', 1)], transaction, 'completed publication when exclude changed'),
    ('an interrupted exclusion stage cannot rebase', publish, [
        ('previous.text !== null && !receipt.committed && receipt.outputs.every(stage => stage === null)',
         'previous.text !== null && !receipt.committed && !receipt.exclude && receipt.outputs.every(stage => stage === null)', 1)], transaction, 'peer publishes through the shared exclusion'),
    ('empty retry erases a reserved Git effect', publish, [
        ('if (prepared.documents && prepared.git.exclude && !baseline)', 'if (false && prepared.documents && prepared.git.exclude && !baseline)', 1)], native, 'interrupted Git snapshot with full then empty'),
    ('borrowed transcript reads lose their finite end', 'src/lib/transcriptLines.ts', [
        ('options.end ?? Infinity', 'Infinity', 1)], reader, 'borrowed descriptor and finite snapshot'),
    ('a staged descriptor borrows restored pathname authority', publish, [
        ('if (!opened.isFile() || opened.nlink !== 1n || nativeFileKey(lstatSync(path, { bigint: true })) !== nativeFileKey(opened)) return held()', 'void opened', 1)], transaction, 'temporarily substituted project directory'),
    ('the process loses conflict identity', 'src/services/handoffProcess.ts', [
        ("'HANDOFF_UNAVAILABLE', 'CHANGE_CONFLICT'", "'HANDOFF_UNAVAILABLE'", 1)], process, 'typed CHANGE_CONFLICT reply'),
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
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


baseline = run([native, transaction, golden, process, reader])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, edits, target, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    changed = original
    for before, after, count in edits:
        assert changed.count(before) == count, (label, changed.count(before), count)
        changed = changed.replace(before, after)
    try:
        path.write_text(changed)
        result = run([target], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Uncaught mutations: ' + ', '.join(failures))
