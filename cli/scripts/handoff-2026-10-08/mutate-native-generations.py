"""Generation control must keep tombstones, original authority and ambiguity."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
source = cli / 'src/core/turns/nativeGenerations.ts'
spec = 'src/core/turns/nativeGenerations.spec.ts'
mutations = [
    ('submission treated as execution',
     "if (kind === 'submitted') state.submitted = true",
     "if (kind === 'submitted') { state.submitted = true; state.executed = true }",
     'queued or rejected submissions'),
    ('late activity reopens a terminal generation',
     'running: state.executed && terminal === undefined', 'running: state.executed',
     'late output belongs'),
    ('Stop ignored without a start',
     'if (status) state.stops.add(status)', 'if (status && state.submitted) state.stops.add(status)',
     'Stop before any start'),
    ('Cancel loses to a delayed native Stop',
     "state.cancelled ? 'cancelled'", "state.cancelled && state.stops.size === 0 ? 'cancelled'",
     'restores Cancel tombstones'),
    ('contradictory terminal status becomes successful',
     "state.stops.size > 1 ? 'unresolved'", "state.stops.size > 1 ? 'completed'",
     'conflicting terminal outcomes'),
    ('native aborted status is rewritten as success',
     "const status = kind === 'stopped' ? input.status : undefined",
     "const status = kind === 'stopped' ? 'completed' as const : undefined",
     'aborted Stop before any start'),
    ('overlap chooses the first arrival',
     'projected.filter(turn => turn.running)', 'projected.filter(turn => turn.running).slice(0, 1)',
     'overlapping generations independently'),
    ('identity conflicts become duplicate deliveries',
     "if (previous !== fingerprint) unavailable('a retained fact identity has conflicting content')", '',
     'conflicting reuse of a delivery identity'),
    ('owner captured by mutable reference',
     'const original = Object.freeze({ ...owner })', 'const original = owner',
     'mutations to the supplied original owner'),
    ('first source authority proof omitted',
     'verifySource()\n      // Only bounded', '// Only bounded',
     'preserves source proof failure'),
    ('final source authority proof omitted',
     '      verify()\n      return Object.freeze', '      return Object.freeze',
     'preserves source proof failure'),
    ('effect uses a replacement proof callback',
     '        verifySource()\n        verifyOwner()\n        check()', '        source.verify()\n        verifyOwner()\n        check()',
     'immutable observations'),
    ('effect accepts a changed source owner',
     "if (identity(source.owner) !== scope) unavailable('the retained source owner changed')", '',
     'revokes a view when its source'),
    ('read runs after its owner was revoked',
     '      check()\n      const source', '      const source',
     'checks ownership before reading'),
    ('read result used after owner revocation',
     '      const source = await read()\n      check()', '      const source = await read()',
     'checks ownership before reading'),
    ('proof-triggered owner revocation ignored',
     '        verifySource()\n        verifyOwner()\n        check()', '        verifySource()\n        verifyOwner()',
     'final source proof itself revokes'),
    ('full proof can silently replace its source owner',
     '        verifySource()\n        verifyOwner()', '        verifySource()',
     'source-owner replacement inside full proof'),
    ('fact bound bypassed',
     'source.facts.length > MAX_FACTS', 'source.facts.length > MAX_FACTS + 1',
     'bounds both complete source facts'),
    ('generation bound bypassed',
     'generations.size === MAX_GENERATIONS', 'generations.size > MAX_GENERATIONS',
     'bounds both complete source facts'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


baseline = run()
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native generation baseline passed', flush=True)
original = source.read_text()
failures = []
for label, before, after, pattern in mutations:
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
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
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
