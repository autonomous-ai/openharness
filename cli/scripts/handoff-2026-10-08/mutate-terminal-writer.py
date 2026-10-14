"""Prove cancellation and ownership checks at the composed pane dispatch boundary."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
writer = 'src/core/terminals/writer.ts'
control = 'src/core/terminals/control.ts'
device = 'src/core/deviceInput.ts'
composition = 'src/core/terminals/writeComposition.spec.ts'
unit = 'src/core/terminals/writer.spec.ts'
mutations = [
    ('old input regains authority after Cancel', writer, '    state.epoch++', '',
     unit, 'revokes preparation immediately'),
    ('logical cancellation waits for a worker', writer, '    state.logical?.cancel()', '',
     unit, 'revokes preparation immediately'),
    ('interrupt races unsettled physical I/O', writer, '      state.physical++', '',
     unit, 'drains only actual pane I/O'),
    ('abandoned preparations escape the capacity limit', writer, 'if (state.preparing >= maxPreparing)', 'if (false)',
     unit, 'bounds actual abandoned preparation'),
    ('old pin release removes its replacement', control, '      if (pinnedWrites.get(agentId) !== write) return', '',
     composition, 'cannot use or release a replaced pinned scope'),
    ('literal omits original owner at dispatch', control,
     'const current = () => paneReadIdentity(resolve(original.agentId)) === identity && ticket.allowed()',
     'const current = () => ticket.allowed()', composition, 'refuses a literal when'),
    ('native proof can cross interrupt deadline', control,
     'const current = () => (!allowed || allowed()) && (!pin || pin.allowed()) && paneReadIdentity(resolve(original.agentId)) === identity && ticket.allowed()',
     'const current = () => ticket.allowed() && (!allowed || allowed()) && (!pin || pin.allowed()) && paneReadIdentity(resolve(original.agentId)) === identity',
     composition, 'checks the interrupt deadline'),
    ('first binding launders changed runtime evidence', control,
     '        if (paneReadIdentity(beforeBinding) !== paneReadIdentity(original)) return false', '',
     composition, 'cannot launder a changed first-bind-runtime'),
    ('cancelled device preparation can still paste', device,
     'const allowed = () => this.states.get(id) === state && state.active === item && !item.cancelled && item.write.allowed()',
     'const allowed = () => item.write.allowed()', composition, 'revokes a device message during'),
    ('failed cancelled preparation retains its lock', device,
     '} catch {\n      if (this.states.get(id) !== state || item.cancelled) { this.finishWrite(id, state, item); return }',
     '} catch {\n      if (this.states.get(id) !== state || item.cancelled) return',
     composition, 'releases cancelled preparation that rejects'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=45)


baseline = run([unit, composition])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Shared writer and real terminal composition baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([file], pattern)
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
