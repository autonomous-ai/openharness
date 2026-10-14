"""Native transcript history must never borrow generation control authority."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
control = 'src/core/turns/nativeTurnControl.ts'
attach = 'src/core/transcripts/attach.ts'
ingest = 'src/core/transcripts/ingest.ts'
funnel = 'src/core/turns/funnel.ts'
mutations = [
    ('input enters running native work', control,
     "purpose !== 'answer' && state.view.selection !== 'idle'", 'false',
     'src/core/turns/nativeTurnControl.spec.ts', 'admits an answer'),
    ('an answer chooses an unordered generation', control,
     "state.view.selection === 'ambiguous'", 'false',
     'src/core/turns/nativeTurnControl.spec.ts', 'admits an answer'),
    ('a delayed answer loses its native proof', control,
     "      state.verify()\n      if (pending || cancelled)", '      if (pending || cancelled)',
     'src/core/turns/nativeTurnControl.spec.ts', 'admits an answer'),
    ('fresh admission forgets recovered Cancel', control,
     "      if (pending || cancelled) unavailable('admission or Cancel holds this incarnation')",
     "      if (pending) unavailable('admission or Cancel holds this incarnation')",
     'src/core/turns/nativeTurnControl.spec.ts', 'revokes an input proof'),
    ('native history resumes an old turn', attach,
     'if (!historyOnly?.(session) && !session.interpretationHold && !historySuperseded',
     'if (!session.interpretationHold && !historySuperseded',
     'src/core/transcripts/attach.spec.ts', 'keeps native transcript history'),
    ('native history invents a recap', attach,
     'if (!historyOnly?.(session) && !historyExplicitlyClosed', 'if (!historyExplicitlyClosed',
     'src/core/transcripts/attach.spec.ts', 'keeps native transcript history'),
    ('first attach proves delivery by old raw bytes', attach,
     "if (!historyOnly?.(session)) sideRead('device'", "sideRead('device'",
     'src/core/transcripts/attach.spec.ts', 'keeps native transcript history'),
    ('live tail proves delivery by uncorrelated raw bytes', ingest,
     "if (!historyOnly?.(session)) sideRead('device'", "sideRead('device'",
     'src/core/transcripts/ingest.spec.ts', 'keeps native history'),
    ('a worker history error aborts current native work', ingest,
     'if (frame.failure !== undefined && !historyOnly?.(session))', 'if (frame.failure !== undefined)',
     'src/core/transcripts/ingest.spec.ts', 'keeps native history'),
    ('history enters the live lifecycle funnel', funnel,
     'if (historyOnly?.(sessionId))', 'if (false)',
     'src/core/turns/funnel.spec.ts', 'keeps native transcript history'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in list(environment):
    if key in ('TMUX', 'TMUX_PANE') or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(files, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=95)


baseline = run(sorted({item[4] for item in mutations}))
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native admission and history baselines passed', flush=True)
failures = []
for label, name, before, after, spec, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec], pattern)
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
