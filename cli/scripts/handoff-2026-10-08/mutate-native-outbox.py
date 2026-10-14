"""Every disconnected outbox identity, phase or quota wire must fail an assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
journal = 'src/engines/kit/nativeHookJournal.ts'
outbox = 'src/engines/kit/nativeHookOutbox.ts'
mutations = [
    ('outbox kind omitted', journal,
     "const log = kind === 'outbox' ? { log: 'native-hook-outbox' as const } : {}",
     "const log = {}", 'seals the explicit outbox kind'),
    ('wire bytes omitted from fingerprint', outbox,
     'hash(JSON.stringify([NAMESPACE, id, firedAt, payload]))',
     'hash(JSON.stringify([NAMESPACE, id, firedAt]))', 'fingerprint binds body'),
    ('original time omitted from fingerprint', outbox,
     'hash(JSON.stringify([NAMESPACE, id, firedAt, payload]))',
     'hash(JSON.stringify([NAMESPACE, id, payload]))', 'fingerprint binds time'),
    ('registration acknowledges every phase', journal,
     'delivery.acknowledgements!.add(event.phase);',
     'for (const phase of delivery.intake.phases!) delivery.acknowledgements!.add(phase);',
     'normalizes ownership ACKs once'),
    ('new ACK record reservation omitted', journal,
     '+ intake.phases!.length : pending * 2', '+ 0 : pending * 2',
     'already outstanding ACK records at limit 2'),
    ('older ACK reservations omitted', journal,
     'deliveries.reduce((count, item) => count + outstanding(item), 0) + intake.phases!.length',
     'intake.phases!.length', 'already outstanding ACK records at limit 5'),
    ('ACK byte reservation omitted', journal,
     "kind === 'outbox' ? needed * ackBytes", "kind === 'outbox' ? 0",
     'both copies of every ACK'),
    ('input captured after yielding', outbox,
     'const payload: Payload = { version: 1, port: input.port,',
     'await Promise.resolve(); const payload: Payload = { version: 1, port: input.port,',
     'retains original bytes before awaiting'),
    ('immutable recovered fingerprint unchecked', outbox,
     'intake.fingerprint !== fingerprint(intake.id, intake.firedAt!, payload)', 'false',
     'changed on-disk body'),
    ('wrong shard accepted', outbox,
     "if (nativeHookOutboxShard(id) !== shard)", 'if (false)', 'wrong shard'),
    ('recovered namespace proof dropped', journal,
     "if (kind === 'outbox') verifyAuthority()", '', 'keeps namespace and close authority|revoked destination owner'),
    ('outbox uses undersized effects envelope', journal,
     "kind === 'outbox' ? 720 * 1024 : 300_000", '300_000', 'two maximum HTTP bodies'),
    ('recovered ACK not durably confirmed', outbox,
     'await snapshot.confirm(); snapshot.verify()', '', 'expose recovered ACKs before confirming'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                           'src/engines/kit/nativeHookOutbox.spec.ts', '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=90)


baseline = run()
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Outbox storage baseline passed', flush=True)
failures = []
for label, relative, before, after, pattern in mutations:
    source = cli / relative
    original = source.read_text()
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
