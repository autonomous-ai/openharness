"""Break fork-source ownership only in an explicitly owned disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_MUTATIONS_OWNED') == '1'
assert subprocess.check_output(['git', 'status', '--porcelain'], cwd=cli, text=True) == ''
repair = 'src/lib/sessionRepair.ts'
descriptors = 'src/lib/nativeConversation.ts'
repair_spec = 'src/lib/sessionRepair.spec.ts'
descriptor_spec = 'src/lib/nativeConversation.spec.ts'
stop_spec = 'src/lib/captureResumeIdentity.spec.ts'
bind_spec = 'src/core/agents/bind.spec.ts'
mutations = [
    ('recent-file source retained', repair, 'if (found.sessionId === opts?.excludedSessionId) continue', '', repair_spec, 'excludes a known fork parent', 1),
    ('Stop omits fork source', 'src/lib/captureResumeIdentity.ts', '...(session.forkedFrom?.sessionId ? { excludedSessionId: session.forkedFrom.sessionId } : {}),', '', stop_spec, 'does not give an unbound', 1),
    ('binding omits fork source', 'src/core/agents/bind.ts', '...(agent.forkedFrom?.sessionId ? { excludedSessionId: agent.forkedFrom.sessionId } : {}),', '', bind_spec, 'keeps a stopped parent', 1),
    ('open source accepted', descriptors, 'if (meta.id === options.excludedSessionId) continue', '', descriptor_spec, 'excludes a fork source', 1),
    ('descriptor inference omits fork source', repair, ', excludedSessionId: opts.excludedSessionId', '', repair_spec, 'reads a live process', 1),
    ('excluded header not rechecked', descriptors, 'headers.push({ key, verify: header.verify })', 'if (header.meta.id !== options.excludedSessionId) headers.push({ key, verify: header.verify })', descriptor_spec, 'retains changed evidence', 1),
    ('database source accepted', repair, '&& id !== excludedSessionId', '', repair_spec, 'from a limited pool', 1),
    ('database lookup omits fork source', repair, '        opts?.excludedSessionId,', '', repair_spec, 'from a limited pool', 3),
    ('truncated pool treated as complete', repair, 'const rows = result.rows', 'const rows = result.rows.filter(row => row.id !== excludedSessionId)', repair_spec, 'from a limited pool', 1),
    ('Hermes source retained', repair, 'if (row.id === opts?.excludedSessionId) continue', '', repair_spec, 'complete Hermes pool', 1),
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


baseline = run([repair_spec, descriptor_spec, stop_spec, bind_spec])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, spec, pattern, expected in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == expected, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec], pattern)
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
