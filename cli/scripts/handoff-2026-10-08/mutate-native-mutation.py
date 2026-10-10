"""Owned disposable worktree only: mutation safety and healthy protocol must be asserted."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_MUTATIONS_OWNED') == '1'
golden = 'src/engines/nativeMutation.golden.spec.ts'
faults = 'src/engines/nativeMutation.spec.ts'
dispatch = 'src/engines/kit/nativeMutationDispatch.spec.ts'
retarget = 'src/core/agents/retarget.spec.ts'
native = 'src/engines/kit/nativeSessionModel.ts'
control = 'src/core/agents/retarget.ts'
mutations = [
    ('native provider protocol', 'src/engines/opencode/contract.ts', "provider: 'providerID'", "provider: 'provider'", golden, ''),
    ('unreadable catalog admits write', native, 'const known = await listsModel(run, requested, receipt.cwd)', 'const known = (await listsModel(run, requested, receipt.cwd)) ?? true', faults, 'required catalog'),
    ('uncertain receipt forgotten', native, 'const previous = pending.get(sessionId)', 'const previous = undefined', faults, 'across later requests'),
    ('wrong conversation accepted', native, "|| data[fields.id] !== sessionId", '', faults, 'matching model data'),
    ('legacy fallback ignores pending write', native, 'if (pending.has(sessionId)) return', 'if (false) return', dispatch, 'does not bypass'),
    ('stdin kept open', native, 'child.stdin?.end()', "child.stdin?.write('')", dispatch, 'bounds children'),
    ('retarget follows mutable row', control, 'const session = structuredClone(live)', 'const session = live', retarget, 'mutable row'),
    ('retarget loses revocable authority', control, 'return () => !!registry.byAgent(session.agentId) && owns()', 'return () => true', retarget, 'owner changes during'),
    ('route expires during swap', control, 'holdRoute(routeKey, null)', 'holdRoute(routeKey)', retarget, 'past the default hold timer'),
    ('old retarget releases newer Stop', control, 'releaseRoute?.()', ";(agentReconciler as TerminalAgentReconciler).releaseRoute(routeKey)", retarget, 'newer Stop route hold'),
    ('confirmed native effect hidden', control, "nativeEffect = written.ok ? 'applied' : (written.effect ?? 'none')", "nativeEffect = 'none'", retarget, 'discloses an applied model'),
    ('environment dispatch not fenced', 'src/lib/tmuxBackend.ts', "if (current?.() === false) return terminalActionNotStarted('The harness changed before clearing its environment')", '', 'src/lib/tmuxBackend.spec.ts', 'revoked during session lookup'),
    ('signal escalation not fenced', 'src/lib/deleteAgentFallback.ts', "if (deps.current?.() === false) return 'not-ours'", '', 'src/lib/deleteAgentFallback.spec.ts', 'ownership is revoked'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_NATIVE_MUTATION_GOLDEN', 'RECORD_OPENCODE_LAUNCH_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(files, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


baseline = run([golden, faults, dispatch, retarget, 'src/lib/tmuxBackend.spec.ts', 'src/lib/deleteAgentFallback.spec.ts'])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, spec, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    expected = 4 if label == 'signal escalation not fenced' else 1
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
