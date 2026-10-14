"""Recovery composes original allocation proof without granting another launch."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
controller = 'src/core/agents/nativeRearmRecovery.ts'
reader = 'src/engines/kit/nativeRearmProof.ts'
receipts = 'src/lib/agentCreationReceipt.ts'
unit = 'src/core/agents/nativeRearmRecovery.spec.ts'
storage = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
mutations = [
    ('reply timeout releases actual read capacity', controller,
     'await actual', 'void actual', unit, 'retains four real reader observations'),
    ('reader deadline claims actual I/O settled', reader,
     'expired = true', 'expired = true; settle()', unit, 'retains four real reader observations'),
    ('recovery skips durable replacement', controller,
     'registry.commitNativeReplacement(owner, replacement, current)',
     'owner', unit, 'confirms the original dispatch'),
    ('old bound process stands in for original recovery', controller,
     'proof.recover(owner, receipt, fence, owner.tmuxPane)',
     'proof(owner, receipt, fence)', unit, 'confirms the original dispatch'),
    ('confirmation drops original execution proof', controller,
     'published.verify(); replacement.verifyConfirmation(); current()',
     'published.verify(); current()', unit, 'retains native-confirm evidence'),
    ('confirmation discards its final retained proof', controller,
     'confirmed.verify()', 'void confirmed', unit, 'retains post-receipt evidence'),
    ('explicit revocation permits a late hold', controller,
     '!closed && !attempt.revoked && attempts.get(agentId) === attempt',
     '!closed && attempts.get(agentId) === attempt', unit, 'revokes a delayed proof after revoke'),
    ('expired revoked reads overwrite current status', controller,
     "finish(hold(owner, 'native recovery exceeded its deadline', present))",
     "finish(hold(owner, 'native recovery exceeded its deadline', () => true))", unit, 'revoked read publish a hold'),
    ('own confirmation invalidates the proof needed to confirm it', reader,
     'receipt.verifyConfirmation(); current()', 'receipt.verify(); current()',
     'src/engines/kit/nativeRearmProof.spec.ts', 'separates the consumed source leaf'),
    ('confirmation adopts another writer inode after sync', receipts,
     'proof => { publication = proof }',
     'proof => { publication = { ...proof, verify() {} } }', storage, 'own actual confirmation inode'),
    ('confirming proof forgets original process inode', receipts,
     'source.verifyConfirmation(); proof.verify()', 'source.verifyConfirmation()', storage, 'original process inode through'),
    ('saved recovery follows the historical pane', controller,
     'proof.recoverSaved(owner, receipt, fence)', 'proof.recover(owner, receipt, fence, owner.tmuxPane)',
     unit, 'recovers a saved Resume across'),
    ('saved handoff current fence rereads consumed ownership', controller,
     'if (!fromSaved && !sameOwner(owner))', 'if (!sameOwner(owner))', unit, 'recovers a saved Resume across'),
    ('replacement publisher changes the admitted owner', controller,
     'nativeTurnTarget(value) !== nativeTurnTarget(expected) || !same(value.nativeControl, expectedControl)',
     'false', unit, 'changed by the replacement publisher'),
    ('saved transfer ignores the complete original request', controller,
     ' || !same(nativeRearmRequest(original.nativeControl), request)', '', unit, 'retained request changed'),
    ('saved transfer accepts another process', controller,
     ' || transfer.processKey !== replacement.key', '', unit, 'retained process changed'),
    ('saved transfer accepts another pane', controller,
     ' || transfer.pane !== replacement.pane', '', unit, 'retained pane changed'),
    ('saved transfer accepts another destination', controller,
     ' || transfer.pendingTarget !== nativeTurnTarget(pending)', '', unit, 'retained pending-target changed'),
    ('confirmation drops the transferred archive proof', controller,
     'const verifyConfirmation = () => { archive?.verify(); published.verify(); replacement.verifyConfirmation(); current() }',
     'const verifyConfirmation = () => { published.verify(); replacement.verifyConfirmation(); current() }',
     unit, 'retains the transferred archive'),
    ('late absence check replaces saved hold evidence', controller,
     'source.verify(); absent.verify(); source.verify()', 'source.verify(); absent.verify()',
     unit, 'retains the saved leaf after'),
    ('late saved control loses to a held notification', controller,
     'sameOwner(row, saved.get(row.agentId) ?? undefined)', 'true', unit, 'checks the current saved'),
    ('receipt preflight starts a new deadline', controller,
     'if (performance.now() >= deadline) return Promise.resolve(hold(owner, \'native recovery exceeded its deadline\'))\n        if (status.state',
     'if (status.state', unit, 'preflight consumes the original deadline'),
    ('reply timer ignores time spent reading receipts', controller,
     'Math.max(0, deadline - performance.now())', '5000', unit, 'arms the reply timer'),
    ('completed launch discards its final retained proof', controller,
     'completed.verify()', 'void completed', unit, 'confirmed receipt final-proof'),
    ('completed launch grants dispatch result without explicit confirmation', receipts,
     ' || retained[3].content === null', '', storage, 'does not use direct-success'),
    ('completed launch grants receipt without a process witness', receipts,
     ' || retained[4].content === null', '', storage, 'does not use no-witness'),
    ('completed launch loses retained original file proofs', receipts,
     'for (const part of retained) part.verify()\n      // A late contradictory effect',
     '// A late contradictory effect', storage, 'part of confirmed relaunch completion'),
    ('completed launch forgets contradictory memory-only outcomes', receipts,
     'const known = this.intentResults.get(id)\n      if (known &&',
     'const known = undefined\n      if (known &&', storage, 'contradictory late .* cannot be persisted'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(specs, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=240)


baseline = run([unit, storage, 'src/engines/kit/nativeRearmProof.spec.ts'])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native rearm recovery baseline passed', flush=True)
failures = []
for label, path, before, after, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    try:
        assert original.count(before) == 1, (label, original.count(before))
        source.write_text(original.replace(before, after))
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Unproven mutations: ' + ', '.join(failures))
print(f'All {len(mutations)} recovery wiring faults caught by assertions', flush=True)
