"""Explicit first-launch receipts must not inherit relaunch or replay authority."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
receipt = 'src/lib/agentCreationReceipt.ts'
parser = 'src/lib/nativeCreateRequest.ts'
unit = 'src/lib/agentCreationReceipt.nativeCreate.spec.ts'
schema = 'src/lib/nativeCreateRequest.spec.ts'
mutations = [
    ('first publisher loses its exec permit', receipt, [
        ('return this.recordNativeLaunchProcess(id, input, process, authority)\n  }\n\n  private recordNativeLaunchProcess',
         'this.recordNativeLaunchProcess(id, input, process, authority); return null\n  }\n\n  private recordNativeLaunchProcess')],
     unit, 'confirms the exact initial allocation'),
    ('retry executes again', receipt, [('if (before.content !== null) return null', 'if (before.content !== null) return { verify() {} }')],
     unit, 'confirms the exact initial allocation'),
    ('candidate metadata replaces durable IDs', receipt, [('prepare(saved.request, authority)', 'prepare(request, authority)')],
     unit, 'first durable generated IDs'),
    ('initial request skips prepublication bounds', receipt, [("request.kind === 'native-create-v2' && !nativeCreationRequest(id, { request, fingerprint })", 'false')],
     unit, 'refuses oversized initial intent'),
    ('initial request ignores semantic fingerprint', receipt, [(' && input.fingerprint === nativeCreateFingerprint(request)', '')],
     unit, 'refuses fingerprint initial intent'),
    ('initial request ignores original creation ID', receipt, [(' && request.creationId === id && input.fingerprint', ' && input.fingerprint')],
     unit, 'refuses id initial intent'),
    ('witness ignores generated metadata conflict', receipt, [
        ("  private nativeRelaunchDispatch(id: string, input: NativeRelaunchRequest) {\n    const expected = structuredClone(input), receipt = this.read(id)\n    if (!nativeLaunchRequest(id, expected) || receipt?.version !== 2 || 'cancelled' in receipt\n      || receipt.fingerprint !== expected.fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(expected.request))",
         "  private nativeRelaunchDispatch(id: string, input: NativeRelaunchRequest) {\n    const expected = structuredClone(input), receipt = this.read(id)\n    if (!nativeLaunchRequest(id, expected) || receipt?.version !== 2 || 'cancelled' in receipt\n      || receipt.fingerprint !== expected.fingerprint)")],
     unit, 'refuses competing agentId metadata'),
    ('initial witness can omit allocation provenance', receipt, [
        ("return request.kind !== 'native-create-v2' || !!process?.namespace && !!process.allocation", 'return true')],
     unit, 'refuses incomplete allocation'),
    ('confirmation half-writes without a witness', receipt, [
        ("      || receipt.request.kind === 'native-create-v2' && (!observedProcess || !completeInitialProcess(receipt.request, observedProcess.process))\n", '')],
     unit, 'opened pane or missing witness'),
    ('opened pane grants initial success', receipt, [
        ("      if (saved.request.kind === 'native-create-v2' && observed.state !== 'created' && outcome.state === 'created') outcome = { state: 'unconfirmed' }\n", '')],
     unit, 'opened pane or missing witness'),
    ('initial outcome borrows resume semantics', receipt, [("? Object.keys(outcome).sort().join(',') === 'agentId,state'", "? Object.keys(outcome).sort().join(',') === 'agentId,resumed,state'")],
     unit, 'refuses a borrowed or mismatched'),
    ('cold confirmation can lose the witness', receipt, [(" || receipt.request.kind === 'native-create-v2' && !process", '')],
     unit, 'cold missing-witness damage'),
    ('cold initial outcome skips kind validation', receipt, [('|| !validNativeSuccess(receipt.request, confirmed.outcome)', '')],
     unit, 'cold resumed-outcome damage'),
    ('cold created result needs no confirmation', receipt, [("&& (!validNativeSuccess(receipt.request, value.outcome) || !confirmed)", '&& (!validNativeSuccess(receipt.request, value.outcome))')],
     unit, 'opened pane or missing witness'),
    ('initial non-dispatch borrows rearm outcome', receipt, [("? 'NATIVE_CREATE_NOT_DISPATCHED' : 'NATIVE_REARM_NOT_DISPATCHED'", "? 'NATIVE_REARM_NOT_DISPATCHED' : 'NATIVE_REARM_NOT_DISPATCHED'")],
     unit, 'does not borrow NATIVE_REARM_NOT_DISPATCHED'),
    ('rearm reader accepts first-create input', receipt, [
        ("    if (!nativeRelaunchRequest(id, input.request)) throw new AgentCreationReceiptError('CREATION_CONFLICT')\n    return this.readNativeLaunchProcess(id, input)",
         '    return this.readNativeLaunchProcess(id, input)')],
     unit, 'separate from every rearm API'),
    ('first request exceeds allocation capacity', parser, [('NATIVE_CREATE_REQUEST_BYTES = 24 * 1024', 'NATIVE_CREATE_REQUEST_BYTES = 256 * 1024')],
     unit, 'refuses oversized initial intent'),
    ('sparse entries replace the array length bound', parser, [('    if (array && part.length > 128) return false\n', ''),
        ('return !array || entries === part.length', 'return true')],
     schema, 'sparse array length before JSON'),
    ('hidden custom JSON executes after the bound', parser, [("      || Object.getOwnPropertyDescriptor(part, 'toJSON')\n", '')],
     schema, 'hidden JSON serialization'),
    ('field access executes before validation', parser, [("        || !Object.hasOwn(descriptor, 'value')\n", ''),
        ('!json(descriptor.value, depth + 1)', '!json((part as Record<string, unknown>)[key], depth + 1)')],
     schema, 'refuses enumerable accessors'),
    ('hidden fields supply required choices', parser, [('  value = structuredClone(value)\n', '')],
     schema, 'durable copy of the required input'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR required'


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=120)


selected = set(sys.argv[2:])
if selected:
    assert selected <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
baseline = run([unit, schema])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Initial receipt baselines passed', flush=True)
failures = []
for label, filename, changes, spec, pattern in mutations:
    source = cli / filename
    original = source.read_text()
    changed = original
    for before, after in changes:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        source.write_text(changed)
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
print(f'All {len(mutations)} initial receipt faults caught by assertions', flush=True)
