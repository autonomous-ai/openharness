"""Stop must account for an allocation from retained durable receipt evidence."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
receipt = 'src/lib/agentCreationReceipt.ts'
spec = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
golden = 'src/lib/nativeReceiptCleanup.golden.spec.ts'
mutations = [
    ('forgets exact request binding', 'receipt.fingerprint !== expected.fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(expected.request)))',
     'receipt.fingerprint !== expected.fingerprint))', spec, 'accounts for an exact'),
    ('forgets semantic options binding', 'receipt.fingerprint !== expected.fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(expected.request)))',
     'creationFingerprint(receipt.request) !== creationFingerprint(expected.request)))', spec, 'accounts for an exact'),
    ('binds a tombstone to another request ID', "request.kind === 'native-rearm' && request.creationId === id && validCreationId(request.launchToken)",
     "request.kind === 'native-rearm' && validCreationId(request.launchToken)", spec, 'pre-receipt tombstone'),
    ('strands pre-receipt cancellation', "const kind = 'cancelled' in receipt && proof.status.state === 'cancelled' ? 'cancelled-id'",
     "const kind = false ? 'cancelled-id'", spec, 'pre-receipt tombstone'),
    ('accepts unknown dispatch outcomes', "&& proof.status.state === 'failed' ? 'not-dispatched' : null",
     "&& proof.status.state === 'failed' ? 'not-dispatched' : 'not-dispatched'", spec, 'never treats'),
    ('accepts a generic failure as undispatched', "        && proof.result.outcome.error === (expected.request.kind === 'native-create-v2' ? 'NATIVE_CREATE_NOT_DISPATCHED' : 'NATIVE_REARM_NOT_DISPATCHED')\n",
     '', spec, 'never treats generic-failure'),
    ('drops retained file and absence verification', 'for (const part of retained) part.verify()',
     'for (const part of retained) void part', golden, '.'),
    ('skips shared receipt durability', 'inspectNativeControlFile(files[index], this.directory).confirm(verify)',
     'void files[index]', spec, 'confirms .*durability|confirms the exact receipt'),
    ('drops contradictory in-memory outcomes', "if (known && ('cancelled' in receipt || claim?.kind !== 'dispatch' || known.fingerprint !== receipt.fingerprint",
     "if (false && known && ('cancelled' in receipt || claim?.kind !== 'dispatch' || known.fingerprint !== receipt.fingerprint", spec, 'contradictory late|late contradictory'),
    ('skips original saved request matching', 'if (receipt.fingerprint !== fingerprint || creationFingerprint(receipt.request) !== creationFingerprint(request))',
     'if (false)', golden, '.'),
    ('grants completion without confirmation', "|| !proof.confirmation || !proof.process)",
     ")", spec, 'does not use .*durable relaunch completion'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=240)


selected = sys.argv[2:]
if selected:
    assert set(selected) <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
baselines = [([row[3]], row[4]) for row in mutations] if selected else [([spec, golden], '.')]
for files, pattern in baselines:
    result = run(files, pattern)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Receipt accounting baselines passed', flush=True)
failures = []
for label, before, after, spec, pattern in mutations:
    source = cli / receipt
    changes = [(before, after)]
    original = source.read_text()
    changed = original
    for before, after in changes:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        source.write_text(changed)
        result = run([spec], pattern)
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
print(f'All {len(mutations)} receipt accounting faults caught by assertions', flush=True)
