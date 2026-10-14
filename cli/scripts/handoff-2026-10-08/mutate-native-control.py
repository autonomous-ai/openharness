"""Native control keeps one owner and proof through reads, keys and interruption."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
control = 'src/core/terminals/control.ts'
unit = 'src/core/terminals/control.spec.ts'
composition = 'src/core/terminals/writeComposition.spec.ts'
mutations = [
    ('revoked control pin authorizes a late lease', control,
     'pinnedWrites.get(agentId) === write && !invalidControls.has(agentId)',
     'pinnedWrites.get(agentId) === write', unit, 'revokes a retained pin while'),
    ('control pin adopts a replacement conversation', control,
     '&& paneReadIdentity(resolve(agentId)) === identity && original.allowed()',
     '&& original.allowed()', unit, 'never borrows a replacement conversation'),
    ('lease proceeds before native admission', control,
     '    if (admission && !await admission.ready) return null', '',
     unit, 'holds a control pin through native admission'),
    ('late admission verifies a replaced pin', control,
     'const permit = await prepare()\n        if (!current()) return false',
     'const permit = await prepare()', unit, 'settles an admission waiter'),
    ('control drops its retained native verifier', control,
     'try { verify?.() } catch { return false }', '',
     unit, 'holds a control pin through native admission'),
    ('caller dispatch bypasses native proof', control,
     "      if (!allowed()) throw new TerminalWriteHeld('terminal control revoked')\n      return operation()\n    }),",
     '      return operation()\n    }),', composition, 'a caller-supplied'),
    ('model preparation adopts a new original owner', 'src/lib/runtimeControl.ts',
     'this.deps.acquireInput(session.agentId, { original: session })',
     'this.deps.acquireInput(session.agentId)', composition, 'a model control read cannot adopt'),
    ('input omits native control admission', 'src/core/input.ts',
     "const native = deps.native?.owns(agentId) ? deps.native : undefined",
     'const native = undefined', 'src/core/input.spec.ts', 'pins a copied native owner'),
    ('Cancel inherits the revoked driver pin', control,
     "keyAction(target, 'C-c', allowed, write, true)",
     "keyAction(target, 'C-c', allowed, write)", composition, 'cannot regain a pinned sequence ticket'),
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
print('Native control baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
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
