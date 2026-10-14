"""Saved Cancel and uncertain Resume must survive stale writers and changed authority."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
archive = 'src/lib/stoppedAgents.ts'
proof = 'src/lib/nativeControlFile.ts'
unit = 'src/lib/stoppedAgents.nativeControl.spec.ts'
mutations = [
    ('ordinary snapshot erases a newer Cancel', archive,
     'if (previous?.nativeControl && JSON.stringify(previous.nativeControl) !== JSON.stringify(session.nativeControl))',
     'if (false)', unit, 'an older live archive cannot undo'),
    ('stale peer replaces launch reservation', archive,
     '|| JSON.stringify(saved.nativeControl) !== JSON.stringify(original.nativeControl)\n            && JSON.stringify(saved.nativeControl) !== JSON.stringify(next)',
     '', unit, 'a stale independent store'),
    ('ordinary repair bypasses uncertain publication', archive,
     "if (this.uncertain.has(agentId)) throw Error('Waiting for the original saved native control publication.')",
     '', unit, 'an uncertain publication cannot roll back'),
    ('corrupt saved state becomes absent', archive,
     "if (raw.version !== 1) throw Error('Unknown saved state')", 'if (raw.version !== 1) return null', unit,
     'preserves unknown-version data'),
    ('rename omits final local authority', archive,
     'const beforeCommit = () => { authority.verify(); pending.verifyDirectory(); retained.verify(); authority.current() }',
     'const beforeCommit = () => { authority.verify(); pending.verifyDirectory(); retained.verify() }', unit,
     'checks local revocation after the last file proof before rename'),
    ('marker removal omits final local authority', archive,
     '    authority?.current()\n    unlinkSync(file)', '    unlinkSync(file)', unit,
     'checks local revocation after the last file proof before removing'),
    ('missing receipt is mistaken for missing marker', archive,
     '    authority?.verify()',
     "    try { authority?.verify() } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }", unit,
     'a missing receipt proof'),
    ('publication adopts a new parent proof', archive,
     'pending.verifyDirectory()', 'void 0', unit, 'retains the original parent through publication'),
    ('directory inode grants a new ancestor route', proof,
     '    routes.verify()', '', unit, 'retains the original ancestor route'),
    ('old native reservation is retaken by age', 'src/lib/resumeAgentService.ts',
     '    if (stoppedAgents.get(agentId)?.nativeControl) return null', '', 'src/lib/resumeAgentService.spec.ts',
     'never retakes an old native cancellation reservation by age'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(file, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', file,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for file in dict.fromkeys(mutation[4] for mutation in mutations):
    result = run(file)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Saved native control baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == (5 if label == 'publication adopts a new parent proof' else 1), (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run(file, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
