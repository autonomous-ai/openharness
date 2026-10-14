"""Native relaunch confirmation must refine only the original durable dispatch."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
source = cli / 'src/lib/agentCreationReceipt.ts'
unit = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
mutations = [
    ('late effect hides contradictory success',
     '      return this.intentStatus(id, currentReceipt(), false)\n    }).finally',
     '      return outcome\n    }).finally', 'retains a contradictory late'),
    ('captured peer result is not checked',
     "      || result.content !== null && (!capturedResult || capturedResult.fingerprint !== claim.fingerprint || capturedResult.token !== claim.token\n        || !validOutcome(capturedResult.outcome) || capturedResult.outcome.state !== 'unconfirmed'\n          && creationFingerprint(capturedResult.outcome) !== creationFingerprint(expected.outcome))",
     '', 'does not adopt a peer'),
    ('old in-flight reply bypasses confirmation',
     'return this.currentReply(id, fingerprint, running.result)', 'return running.result', 'rechecks confirmed evidence'),
    ('occupied request adopts a foreign durable receipt',
     "    if (!(receipt.version === 2 && 'cancelled' in receipt) && receipt.fingerprint !== fingerprint) {\n      throw new AgentCreationReceiptError('CREATION_CONFLICT')\n    }\n    if (receipt.version === 2) {",
     '    if (receipt.version === 2) {', 'does not replace an occupied request'),
    ('contradictory result becomes confirmed success',
     "        || [result, known].some(previous => previous && previous.outcome.state !== 'unconfirmed'\n          && creationFingerprint(previous.outcome) !== creationFingerprint(confirmed.outcome))",
     '', 'retains a contradictory late'),
    ('cancelled tombstone hides conflicting confirmation',
     '    const status = this.intentStatus(id, receipt, false)\n    if (\'cancelled\' in receipt || status.state !== \'pending\') return null',
     '    if (\'cancelled\' in receipt) return null\n    const status = this.intentStatus(id, receipt, false)\n    if (status.state !== \'pending\') return null',
     'holds changed cancel evidence'),
    ('publication omits final local revocation',
     'const fence = () => { authority.verify(); retained(); before.verify(); authority.current() }',
     'const fence = () => { authority.verify(); retained(); before.verify() }',
     'finishes the file proof with local authority'),
    ('confirmation read omits durability proof',
     '      proof.confirm(verify); verify(); proof.verify()',
     '      verify(); proof.verify()', 'confirms an identical immutable part after failed parent sync'),
    ('late uncertainty overwrites recovered success',
     "      if (observed.state === 'created' && this.readIntentPart(this.intentFile(id, 'confirmation')) && (outcome.state === 'unconfirmed'\n        || creationFingerprint(outcome) === creationFingerprint(observed))) return observed",
     '', 'keeps a recovered success when the original live publisher'),
    ('recovered witness grants another exec',
     '    if (before.content !== null) return null',
     '    if (before.content !== null) return { verify() {} }', 'only the original witness publisher may continue'),
    ('orphan process witness becomes a fresh request',
     " && !this.readIntentPart(this.intentFile(id, 'process'))", '', 'an orphan process witness prevents'),
    ('negative result hides allocated process',
     " || result?.outcome.state === 'failed' || known?.outcome.state === 'failed'", '',
     'retains a process witness hold after its result'),
    ('witness publication omits final local revocation',
     'const fence = () => { authority.verify(); source.verify(); before.verify(); authority.current() }',
     'const fence = () => { authority.verify(); source.verify(); before.verify() }',
     'checks local revocation after the final file proof before the pre-exec'),
    ('changed witness birth retains authority',
     '    && value.checksum === creationFingerprint({ fingerprint: value.fingerprint, token: value.token, process: value.process })',
     '', 'retains a process witness hold after its birth'),
    ('published witness identity is forgotten before exec',
     'proof.verify(); original.verify(); authority.current()',
     'proof.verify(); authority.current()', 'never adopts a replacement of its own process witness'),
    ('confirmation publication forgets the witness',
     'result.verify(); process.verify(); routes.verify()',
     'result.verify(); routes.verify()', 'holds a replace process witness during confirmation'),
    ('confirmed status forgets the observed witness',
     'outcome.verify(); launched.verify()',
     'outcome.verify()', 'retains the process witness through confirmed status'),
    ('confirmed result permits later witness deletion',
     '        || confirmed.process !== (process?.checksum ?? null)',
     '', 'a later remove cannot change'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', unit,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


result = run()
if result.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native rearm receipt baseline passed', flush=True)
failures = []
for label, before, after, pattern in mutations:
    original = source.read_text()
    assert original.count(before) == (2 if label == 'old in-flight reply bypasses confirmation' else 1), (label, original.count(before))
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
