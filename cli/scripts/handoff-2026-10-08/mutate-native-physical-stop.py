"""Physical Stop faults must fail assertions without contacting an owner's daemon."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
source = cli / 'src/engines/kit/nativePhysicalStop.ts'
spec = 'src/engines/kit/nativePhysicalStop.spec.ts'
mutations = [
    ('engine survival becomes retirement', "if (!await dead(locations[0], engine, budget, probe, helpers))", 'if (false)', 'detached surviving engine'),
    ('active pane after close is treated as stopped', "if (await readPane(allocation, budget, serverDead) === 'active')", 'if (false)', 'active pane after close'),
    ('released fallback is killed', "if (state === 'active')", "if (state === 'active' || state === 'released')", 'accounts a released allocation'),
    ('lost close reply is ignored', 'await closePane(allocation, budget, verify)', 'await closePane(allocation, budget, verify).catch(() => {})', 'lost close reply'),
    ('command follows current default endpoint', "['-S', endpoint.socket, ...args]", 'args', 'different endpoint'),
    ('foreign server inventory grants absence', '!line.startsWith(prefix) || ', '', 'different endpoint'),
    ('missing socket proves live server dead', "return held('original tmux server is alive but its endpoint is unavailable')", "return 'absent'", 'unavailable original socket'),
    ('final receipt verification hides source change', 'const verify = () => { verifyStopped(); verifyOwner(); current() }', 'const verify = () => { verifyOwner(); verifyStopped(); current() }', 'source after independent receipt verification'),
    ('last caller callback bypasses local revocation', "budget.step(); ownerCurrent(); budget.step()\n        if (!active || expired || closed) return held('authority expired or was revoked')", 'budget.step(); ownerCurrent(); budget.step()', 'last caller fence'),
    ('physical proof retains consumed Registry leaf', 'verifyAllocations(); current()\n      }', 'verifyAllocations(); verifyOwner(); current()\n      }', 'independent receipt and scope proof'),
    ('descriptor lifetime ends before retirement', 'const answer = consume(proof)', 'retained.forEach(scope => scope.close()); const answer = consume(proof)', 'independent receipt and scope proof'),
    ('reply expiry prematurely settles actual work', 'if (!launched) settle(); throw error', 'settle(); throw error', 'actual slots and settled promises'),
    ('reply expiry frees occupied slot', "timer = setTimeout(() => { expired = true;", 'timer = setTimeout(() => { expired = true; if (occupied) { running--; occupied = false }', 'actual slots and settled promises'),
    ('cleanup can outlive original deadline', "budget.step(); ownerCurrent(); budget.step()\n          if (expired || closed)", "ownerCurrent();\n          if (expired || closed)", 'deadline again after retained descriptor cleanup'),
    ('final scope can change storage', 'before.boot !== final.boot || before.namespace !== final.namespace || before.storage !== final.storage', 'before.boot !== final.boot || before.namespace !== final.namespace', 'changed final local storage'),
    ('async consumer becomes accepted retirement', "if (answer && (typeof answer === 'object' || typeof answer === 'function') && typeof (answer as { then?: unknown }).then === 'function')", 'if (false)', 'already resolved async consumer'),
    ('old probe count permanently holds admitted workload', 'const budget = input.budget', 'const budget = new NativeEvidenceBudget()', 'all six engines within one bounded Darwin probe budget'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR required'


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


selected = set(sys.argv[2:])
if selected:
    assert selected <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
baseline = run([spec], '|'.join(row[3] for row in mutations)) if selected else run(
    [spec, 'src/engines/kit/nativeRearmWitness.process.spec.ts', 'src/engines/kit/nativeEvidence.spec.ts'])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native physical Stop baselines passed', flush=True)
failures = []
original = source.read_text()
for label, before, after, pattern in mutations:
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if not result.returncode or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Missing assertion proofs: ' + ', '.join(failures))
print(f'All {len(mutations)} physical Stop faults caught by assertions', flush=True)
