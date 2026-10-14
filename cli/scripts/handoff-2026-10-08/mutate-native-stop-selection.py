"""Retained allocation faults must fail assertions before any real effects."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
selector = cli / 'src/engines/kit/nativeStopAllocations.ts'
producer = cli / 'src/engines/kit/nativePhysicalStop.ts'
spec = 'src/engines/kit/nativeStopAllocations.spec.ts'
mutations = [
    (selector, 'pending launch disappears', 'requests.push({ receipt, admitted: false })', '', 'oldest engine, every confirmed allocation'),
    (selector, 'oldest source disappears', "addEngine(original && typeof original === 'object' ? nativeTurnProcess(original as { processKey: unknown; namespace?: unknown }) : null)", '', 'oldest engine, every confirmed allocation'),
    (selector, 'latest Cancel disappears', 'if (control.cancel.processKey !== null)', 'if (false)', 'entire scoped process incarnation'),
    (selector, 'namespace is omitted from engine deduplication', '[owner.boot, owner.namespace, owner.pid, owner.birth]', '[owner.boot, owner.pid, owner.birth]', 'entire scoped process incarnation'),
    (selector, 'unavailable incarnation is silently omitted', "if (!owner || !validNativeHookWriter(owner)) return held('has an unknown original engine incarnation')", 'if (!owner || !validNativeHookWriter(owner)) return', 'non-null cancel without original namespace'),
    (selector, 'complete ownership cap disappears', 'engines.size > NATIVE_ALLOCATION_LIMIT + 2 || panes.size > NATIVE_ALLOCATION_LIMIT + 1', 'false', 'gathers all distinct source obligations'),
    (selector, 'endpoint aliases hide a conflicting lifetime', '[identity(pane.endpoint.server), pane.pane]', '[identity(pane.endpoint.server), pane.endpoint.socket, pane.endpoint.binary, pane.pane]', 'conflicting socket-alias lifetimes'),
    (selector, 'same numbered pane discards another server', '[identity(pane.endpoint.server), pane.pane]', '[pane.pane]', 'preserves same-numbered panes'),
    (selector, 'same ID can replace its original request', 'if (creationFingerprint(admitted.receipt) !== creationFingerprint(receipt))', 'if (false)', 'rejects conflicting-id ownership'),
    (selector, 'admitted witness can fall back to absence', "if (admitted) return held('cannot read an admitted original witness')", '', 'admitted missing witness'),
    (selector, 'claimed unknown request is treated as absent', 'const absent = receipts.readNativeRelaunchNotDispatched(id, receipt)', 'const absent = { verify() {} }', 'claimed request without a witness'),
    (selector, 'foreign witness token is accepted', ' || pane.token !== receipt.request.launchToken', '', 'holds token damage'),
    (selector, 'earlier receipt stops being verified', 'for (const verify of retained) { verify(); current() }', 'for (const verify of retained) { current() }', 'earlier receipt replaced during a later receipt'),
    (selector, 'absence proof is not retained', 'absent.verify(); retained.push(absent.verify); current()', 'absent.verify(); current()', 'pending cancelled-id request'),
    (selector, 'consumed source invalidates physical proof', 'const verifyAllocations = () => {', 'const verifyAllocations = () => { verifyOwner();', 'composes cold receipt selection'),
    (selector, 'source fence repeats every receipt walk', 'const verify = () => { verifyOwner(); current() }', 'const verify = () => { verifyAllocations(); verifyOwner(); current() }', 'source fence separate'),
    (selector, 'unrevoked R grants physical authority', ' || control.rearm && !control.rearm.revoked', '', 'rejects unrevoked ownership'),
    (selector, 'default probe count holds the complete selected workload', 'new NativeEvidenceBudget(NATIVE_EVIDENCE_MS, 320)', 'new NativeEvidenceBudget()', 'funds the complete selected workload'),
    (producer, 'physical work resets selection deadline and counters', 'const budget = input.budget', 'const budget = new NativeEvidenceBudget(3000, 320)', 'original selection deadline'),
    (producer, 'reply timer resets selection deadline', '}, budget.remaining())', '}, 3000)', 'original selection deadline'),
    (producer, 'old engine cap refuses retained pending launch', 'engines.length > NATIVE_ALLOCATION_LIMIT + 2', 'engines.length > NATIVE_ALLOCATION_LIMIT', 'funds the complete selected workload'),
    (producer, 'old pane cap refuses retained pending launch', 'allocations.length > NATIVE_ALLOCATION_LIMIT + 1', 'allocations.length > NATIVE_ALLOCATION_LIMIT', 'funds the complete selected workload'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR required'


def run(pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=90)


selected = set(sys.argv[2:])
if selected:
    assert selected <= {row[1] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[1] in selected]
baseline = run('|'.join(row[4] for row in mutations) if selected else '.')
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native Stop selection baseline passed', flush=True)
originals = {file: file.read_text() for file, *_ in mutations}
failures = []
for source, label, before, after, pattern in mutations:
    original = originals[source]
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(pattern)
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
print(f'All {len(mutations)} native Stop selection faults caught by assertions', flush=True)
