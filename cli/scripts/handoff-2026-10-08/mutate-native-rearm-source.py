"""A pending Restart cannot forget the original engine when Cancel replaces it."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
intent = 'src/lib/nativeTurnIntent.ts'
intent_spec = 'src/lib/nativeTurnIntent.spec.ts'
rearm = 'src/core/agents/nativeRearm.ts'
rearm_spec = 'src/core/agents/nativeRearm.spec.ts'
registry_spec = 'src/lib/registry.nativeControl.spec.ts'
writer = 'src/engines/kit/nativeRearmWitness.ts'
writer_spec = 'src/engines/kit/nativeRearmWitness.spec.ts'
proof = 'src/engines/kit/nativeRearmProof.ts'
proof_spec = 'src/engines/kit/nativeRearmProof.spec.ts'
receipt = 'src/lib/agentCreationReceipt.ts'
receipt_spec = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
mutations = [
    ('reservation forgets the original process', rearm, [(
        'sourceProcess: { processKey: control.cancel.processKey,\n'
        '              ...(control.cancel.namespace === undefined ? {} : { namespace: control.cancel.namespace }) },', '')],
     rearm_spec, 'reserves complete'),
    ('reservation forgets the original PID view', rearm, [(
        '...(control.cancel.namespace === undefined ? {} : { namespace: control.cancel.namespace })', '')],
     registry_spec, 'cold Cancel retains the old engine'),
    ('request drops original engine provenance', intent, [(
        '...(rearm.sourceProcess === undefined ? {} : { sourceProcess: rearm.sourceProcess }),', '')],
     intent_spec, 'reserves only the exact original process'),
    ('parser accepts malformed original provenance', intent, [(
        "Object.hasOwn(rearm, 'sourceProcess') && !parseNativeTurnProcessReference(rearm.sourceProcess)", 'false')],
     intent_spec, 'refuses incomplete original Restart'),
    ('new reservation can omit its original obligation', intent, [(
        '&& proposed.sourceProcess !== undefined && same(source(proposed.sourceProcess), source(previous.cancel))', '')],
     intent_spec, 'reserves only the exact original process'),
    ('new reservation substitutes another engine', intent, [(
        '&& same(source(proposed.sourceProcess), source(previous.cancel))', '')],
     intent_spec, 'reserves only the exact original process'),
    ('reserved original engine can change or be enriched later', intent, [(
        ', source(reserved.sourceProcess)', ''), (', source(proposed.sourceProcess)', '')],
     intent_spec, 'reserves only the exact original process|keeps the original engine obligation'),
    ('parsed original engine remains mutable', intent, [(
        'if (copied.rearm.sourceProcess) Object.freeze(copied.rearm.sourceProcess)', '')],
     intent_spec, 'reserves only the exact original process'),
    ('witness ignores original engine mismatch', writer, [(
        '|| creationFingerprint(request.sourceProcess ?? null) !== creationFingerprint(rearm.sourceProcess ?? null)', '')],
     writer_spec, 'holds (key|namespace) original engine provenance'),
    ('replacement ignores original engine mismatch', proof, [(
        '|| creationFingerprint(intent.sourceProcess ?? null) !== creationFingerprint(rearm.sourceProcess ?? null)', '')],
     proof_spec, 'replacement proof rejects (key|namespace) original engine provenance'),
    ('replacement equates legacy omission with explicit null', proof, [(
        "|| Object.hasOwn(intent, 'sourceProcess') !== Object.hasOwn(rearm, 'sourceProcess')", '')],
     proof_spec, 'replacement proof rejects legacy-null'),
    ('cleanup drops the original engine from its exact request', receipt, [(
        '...(sourceProcess === undefined ? {} : { sourceProcess }),', '')],
     receipt_spec, 'retains original engine provenance'),
    ('cleanup adopts malformed source provenance', receipt, [(
        'parseNativeTurnProcessReference(receipt.request.sourceProcess)', 'receipt.request.sourceProcess')],
     receipt_spec, 'refuses malformed original-engine provenance'),
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


result = run([intent_spec, rearm_spec, registry_spec, writer_spec, proof_spec, receipt_spec])
if result.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Original-engine provenance baselines passed', flush=True)
failures = []
for label, path, changes, spec, pattern in mutations:
    source = cli / path
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
print(f'All {len(mutations)} original-engine provenance faults caught by assertions', flush=True)
