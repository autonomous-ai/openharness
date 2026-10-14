"""Reserved native launches must retain exact, one-use physical authority."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
source = cli / 'src/core/agents/nativeRearm.ts'
spec = 'src/core/agents/nativeRearm.spec.ts'
mutations = [
    ('reservation omitted before receipt', [(
        "row = options.source === 'live' ? registry.commitNativeControl(row, next, compatible)\n"
        '            : saved.commitNativeControl(row, next, { verify: compatible, current: local })',
        'row = structuredClone(row)')], 'reserves complete'),
    ('existing semantic conflict ignored', [(
        'const existing = receipts.has(options.creationId, expected)', 'const existing = false'), (
        'placement(); receipts.has(options.creationId, expected); placement()', 'placement(); placement()')],
        'refuses an existing conflicting'),
    ('revoked missing receipt is not tombstoned', [(
        'if (control.rearm.revoked) return receipts.cancelIntent(options.creationId)',
        "if (control.rearm.revoked) return { state: 'cancelled' }")], 'receipt already cancelled: false'),
    ('recorded request inherits another token', [(
        'if (!same(recorded, request))', 'if (false)')], 'receipt bytes which disagree'),
    ('receipt reply frees unfinished capacity', [(
        'void originalAuthority.settled.then(() => { attempts.delete(options.creationId) })',
        'setTimeout(() => { attempts.delete(options.creationId) }, 5000)')], 'retains capacity for actual physical'),
    ('actual settlement never frees capacity', [(
        'void originalAuthority.settled.then(() => { attempts.delete(options.creationId) })',
        'void originalAuthority.settled.then(() => {})')], 'retains four actual'),
    ('missing lifetime permits preparation', [(
        ' || !originalAuthority.settled', ''), (
        'void originalAuthority.settled.then', 'void originalAuthority.settled?.then')], 'missing lifetime authority'),
    ('changed control retains dispatch authority', [(
        'same(current.nativeControl, control) && ', '')], 'original control changes'),
    ('begin permits changed target', [(
        'nativeTurnTarget(current) === control.rearm!.target',
        '(began || nativeTurnTarget(current) === control.rearm!.target)')], 'executing operation'),
    ('final receipt proof regrants revoked dispatch', [(
        'return target(get(options.source, options.agentId)) && active()',
        'return true')], 'final receipt proof'),
    ('callback completion leaves dispatch guard alive', [(
        'finally { executing = false }', 'finally {}')], 'callback can dispatch after returning'),
    ('committed row remains a mutable alias', [(
        '        row = structuredClone(row)\n        original = row\n        read(options.source, row)',
        '        original = row\n        read(options.source, row)')], 'in-place successor'),
    ('begin grants a second physical dispatch', [(
        'if (began || !currentEffect())', 'if (!currentEffect())')], 'records twice dispatch'),
    ('effect callback declares unproven success', [(
        "return began ? { state: 'unconfirmed' } : notDispatched",
        "return began ? { state: 'created', agentId: options.agentId, resumed: true } : notDispatched")], 'reserves complete'),
    ('saved dispatch uses only local Registry absence', [(
        "const absence = options.source === 'saved' ? registry.readNativeAbsence(options.agentId) : undefined",
        'const absence = undefined')], 'retains durable absence'),
    ('final absence proof changes the saved target unnoticed', [(
        'return target(get(options.source, options.agentId)) && active()',
        'return active()')], 'after the final retained absence proof'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=120)


result = run()
if result.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native dispatch baseline passed', flush=True)
original = source.read_text()
failures = []
for label, replacements, pattern in mutations:
    try:
        changed = original
        for before, after in replacements:
            assert changed.count(before) == 1, (label, changed.count(before))
            changed = changed.replace(before, after)
        source.write_text(changed)
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Unproven mutations: ' + ', '.join(failures))
print(f'All {len(mutations)} native dispatch faults caught by assertions', flush=True)
