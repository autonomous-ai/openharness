"""First-launch provenance stays distinct through Registry and physical Stop."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
allocation = 'src/lib/nativeAllocation.ts'
registry = 'src/lib/registry.ts'
stop = 'src/engines/kit/nativeStopAllocations.ts'
unit = 'src/lib/nativeAllocation.spec.ts'
live = 'src/lib/registry.nativeControl.spec.ts'
physical = 'src/engines/kit/nativeStopAllocations.spec.ts'
notify = 'src/engines/kit/nativeNotifyCursor.spec.ts'
golden = 'src/lib/nativeFirstAllocationCompatibility.golden.spec.ts'
mutations = [
    ('initial ordering is ignored', allocation, ' || original[0] !== initial[0]', '', unit, 'older or reordered'),
    ('initial fingerprint is ignored', allocation, 'initial && nativeCreateFingerprint(initial) === value.fingerprint',
     'initial', unit, 'older or reordered'),
    ('version two accepts a rearm-only past', allocation, 'initial.length !== 1 || original[0] !== initial[0]',
     'initial.length > 1', unit, 'older or reordered'),
    ('sparse ledger bypasses complete receipts', allocation, 'Array.from(value.receipts, receipt)', 'value.receipts.map(receipt)',
     unit, 'older or reordered'),
    ('same semantic choice replaces original metadata', allocation, 'creationFingerprint(existing) === creationFingerprint(next)',
     'existing.fingerprint === next.fingerprint', unit, 'older or reordered'),
    ('older golden no longer holds full allocation capacity', allocation, 'saved.receipts.length < NATIVE_ALLOCATION_LIMIT',
     'true', golden, 'former rearm allocation rows'),
    ('cold load downgrades initial schema', registry, 'raw.schemaVersion === 5 ? 5 : ', '',
     live, 'through observation, binding'),
    ('legacy migration loses its schema', registry,
     'raw.schemaVersion === 5 ? 5 : raw.schemaVersion === 4 ? 4 : raw.schemaVersion === 3 ? 3 : 2',
     'raw.schemaVersion', live, 'migrating cold legacy rows'),
    ('generic registration downgrades first admission', registry, 'existing?.schemaVersion === 5 ? 5 : ', '',
     live, 'through observation, binding'),
    ('lost Cancel is mistaken for first admission', registry,
     '(row.schemaVersion === 3 || row.schemaVersion === 4 || row.schemaVersion === 6 && nativeCreation?.revoked === true) !== (nativeControl !== undefined)',
     '(row.schemaVersion === 3 || row.schemaVersion === 4 || row.schemaVersion === 6 && nativeCreation?.revoked === true) !== (nativeControl !== undefined)'
     ' && !(row.schemaVersion === 4 && nativeAllocation && nativeAllocationIsInitial(nativeAllocation))',
     live, 'never reinterprets a lost Cancel'),
    ('initial schema admits later history without Control', registry,
     '(!nativeAllocation || !nativeAllocationIsInitial(nativeAllocation))', '!nativeAllocation',
     live, 'initial schema five with later-rearm'),
    ('initial row accepts another agent receipt', registry,
     'nativeAllocation.receipts.some(value => value.request.agentId !== row.agentId)', 'false',
     live, 'initial schema five with foreign-agent'),
    ('bundled client forgets initial schema', 'src/engines/kit/nativeNotifyCursor.ts', 'row?.schemaVersion === 5', 'false',
     notify, 'distinct initial allocation schema'),
    ('Stop invents a first predecessor', stop, 'if (!initial) {', 'if (true) {',
     physical, 'first creation without inventing'),
    ('Stop borrows a rearm witness for initial creation', stop,
     'receipts.readNativeCreationProcess(id, { fingerprint: receipt.fingerprint, request: initial })',
     'receipts.readNativeRelaunchProcess(id, receipt)', physical, 'first creation without inventing'),
    ('Stop drops initial admitted history', stop,
     '(allocation?.receipts ?? []).map(receipt => ({ receipt, admitted: true }))',
     "(allocation?.receipts ?? []).filter(receipt => receipt.request.kind !== 'native-create-v2').map(receipt => ({ receipt, admitted: true }))",
     physical, 'cold Stop retains initial creation'),
    ('missing initial witness discharges its allocation', stop,
     "if (admitted) return held('cannot read an admitted original witness')",
     "if (admitted && initial) continue\n      if (admitted) return held('cannot read an admitted original witness')",
     physical, 'first creation without inventing'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR required'


def run(files, pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=120)


selected = set(sys.argv[2:])
if selected:
    assert selected <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
baseline = run(list(dict.fromkeys(row[4] for row in mutations)), '|'.join(dict.fromkeys(row[5] for row in mutations)))
if baseline.returncode:
    raise SystemExit('Healthy first-allocation baselines failed; no mutations ran.\n' + baseline.stdout + baseline.stderr)
print('Healthy first-allocation baselines passed', flush=True)
failures = []
for label, name, before, after, spec, pattern in mutations:
    source = cli / name
    original = source.read_text()
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
    raise SystemExit('Missing first-allocation proofs: ' + ', '.join(failures))
print(f'All {len(mutations)} first-allocation faults caught by assertions', flush=True)
