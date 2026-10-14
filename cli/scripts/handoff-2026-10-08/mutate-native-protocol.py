"""Versioned ownership and receipt-only recovery must survive disconnected wiring."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
server = 'src/hookServer.ts'
protocol = 'src/engines/kit/nativeHookClientProtocol.ts'
catalog = 'src/engines/kit/nativeHookCatalog.ts'
http = 'src/hookServer.nativeProtocol.spec.ts'
storage = 'src/engines/kit/nativeHookCatalog.spec.ts'
mutations = [
    ('wire identity normalizes distinct raw bytes', protocol,
     'bodySha256: hash(body) }', 'bodySha256: hash(JSON.stringify(JSON.parse(body))) }', http, 'lost completed reply'),
    ('remembered ownership bypasses final evidence', server,
     '          verifyOwnership()', '          void verifyOwnership', http, 'confirmed intake disappears'),
    ('legacy terminal upgraded into v1 receipt', server,
     'intake.fingerprint !== fingerprint || intake.firedAt !== firedAt\n        || JSON.stringify(intake.wire) !== JSON.stringify(wire)',
     'intake.firedAt !== firedAt', http, 'metadata-less legacy completion'),
    ('completed receipt requires a live engine', server,
     "const origin = inspectNativeHookOrigin(body.nativeOrigin), engine = body.engine ?? 'claude'",
     "return false; const origin = inspectNativeHookOrigin(body.nativeOrigin), engine = body.engine ?? 'claude'", http, 'lost completed reply'),
    ('unretained ignored request gets ownership', server,
     "if (ownership && (status >= 200 && status < 300 || ownership === 'complete' && status === 400)) {\n            json(200, nativeHookAcknowledgement(delivery, phase, ownership))",
     "if (status >= 200 && status < 300) {\n            json(200, nativeHookAcknowledgement(delivery, phase, 'owned'))",
     http, 'early ignored registration'),
    ('missing original ID uses legacy fallback', server,
     "typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,96}$/.test(id)", 'false', http, 'invalid id'),
    ('noncanonical native time accepted', server,
     "!/^[1-9]\\d{0,15}$/.test(fired)", 'false', http, 'invalid time'),
    ('BOM discarded before wire identity', server,
     'fatal: true, ignoreBOM: true', 'fatal: true', http, 'UTF-8 BOM'),
    ('read-only namespace lookup allocates', catalog,
     'const control = pair(versionFile)\n      if (control',
     "await allocate('effects', keys[0]!, check)\n      const control = pair(versionFile)\n      if (control",
     storage, 'looks up only existing'),
    ('selected catalog and seal proofs discarded', catalog,
     'checkRoot(); control.verify(); allocation.pair.verify(); allocation.seal!.verify(); proof.verify()',
     'checkRoot(); allocation.pair.verify()', storage, 'selected receipt authority for empty history'),
    ('capacity reply borrows a conflicting intake', server,
     "if (known && (known.intake.fingerprint !== fingerprint || known.intake.agentId !== processAgent.agentId\n        || known.intake.conversationId !== (body.sessionId ?? ''))) {",
     'if (false) {', http, 'legacy same-ID conflict'),
    ('confirmed rejection keeps legacy refusal transport', server,
     " || ownership === 'complete' && status === 400", '', http, 'first durable rejection'),
    ('recovered rejection keeps legacy refusal transport', server,
     'answer(200, receipt)', 'answer(delivery.result.status, receipt)', http, 'durably rejected registration'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(target, pattern='', timeout=65):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', target, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=timeout)


for target, pattern in [(http, ''), (storage, 'looks up only existing|retains selected receipt authority')]:
    baseline = run(target, pattern, timeout=120)
    if baseline.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native protocol baselines passed', flush=True)
failures = []
for label, relative, before, after, target, pattern in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(target, pattern)
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
