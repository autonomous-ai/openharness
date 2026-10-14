"""Replay must preserve original ownership, bounded I/O and eager core wiring."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
replay = 'src/engines/kit/nativeHookReplay.ts'
transport = 'src/engines/kit/nativeHookTransport.ts'
catalog = 'src/engines/kit/nativeHookCatalog.ts'
unit = 'src/engines/kit/nativeHookReplay.spec.ts'
wire = 'src/engines/kit/nativeHookTransport.spec.ts'
storage = 'src/engines/kit/nativeHookCatalog.spec.ts'
http = 'src/hookServer.nativeProtocol.spec.ts'
files = 'src/engines/kit/nativeHookFiles.ts'
files_unit = 'src/engines/kit/nativeHookFiles.spec.ts'
journal_unit = 'src/engines/kit/nativeHookJournal.spec.ts'
mutations = [
    ('core readiness never starts client replay', 'src/hookServer.ts',
     '    clientReplay.start()', '    void clientReplay.start', http, 'starts retained client replay'),
    ('core drops the remaining transport budget', 'src/hookServer.ts',
     'sendNativeHookRequest(request, hookCredential, () => !closed && current(), remainingMs)', 'sendNativeHookRequest(request, hookCredential, () => !closed && current())', http, 'starts retained client replay'),
    ('legacy success borrows ownership', replay,
     'if (!readNativeHookAcknowledgement(reply, delivery, phase))', 'if (false)', unit, 'holds an unconfirmed reply'),
    ('registration ACK publication disconnected', replay,
     'await outbox.acknowledge(delivery, phase.name)', 'void outbox.acknowledge', unit, 'confirms registration ACK before Stop'),
    ('reconstruction repeats an acknowledged phase', replay,
     'if (phase.acknowledged) continue', 'if (false) continue', unit, 'resumes only the unowned Stop'),
    ('linked phases dispatched backwards', replay,
     'for (const phase of delivery.phases)', 'for (const phase of [...delivery.phases].reverse())', unit, 'confirms registration ACK before Stop'),
    ('snapshot proof disconnected', replay,
     'check(); snapshot.verify(); check()', 'check(); check()', unit, 'immutable evidence at snapshot'),
    ('original delivery proof disconnected', replay,
     'check(); delivery.verify(); check()\n        const reply', 'check(); check()\n        const reply', unit, 'immutable evidence at delivery'),
    ('reply consumes replaced evidence', replay,
     'check(); delivery.verify(); check()\n        if (!readNativeHookAcknowledgement', 'check(); check()\n        if (!readNativeHookAcknowledgement', unit, 'immutable evidence at reply'),
    ('expired transport writes ACK', replay,
     "if (!current()) throw Error('the retained native hook retry deadline was reached')", 'void current', unit, 'actual transport slots'),
    ('productive retries lose serialization', replay,
     ' && (!progressing || !alive(progressing))', '', unit, 'serializes live retries'),
    ('fifth stalled retry admitted', replay,
     'active.size < 4', 'active.size < 5', unit, 'actual transport slots'),
    ('cleanup releases its actual slot early', replay,
     'await outbox?.close()', 'void outbox?.close()', unit, 'actual cleanup slots'),
    ('held ID starves its sibling', replay,
     'lastIds.set(shard, id)', 'void lastIds', unit, 'rotates shards and IDs'),
    ('later phase restarts the attempt budget', replay,
     'Math.max(1, deadline - performance.now())', '(deps.timeoutMs ?? 4500)', unit, 'original attempt budget remaining'),
    ('transport normalizes original bytes', transport,
     'req.end(request.body)', 'req.end(JSON.stringify(JSON.parse(request.body)))', wire, 'exact original bytes'),
    ('transport accepts an HTTP refusal', transport,
     'res.statusCode < 200 || res.statusCode >= 300', 'res.statusCode < 100 || res.statusCode >= 600', wire, 'holds an HTTP'),
    ('response byte cap disconnected', transport,
     'bytes > 16_384', 'bytes > 1_000_000', wire, 'oversized response'),
    ('invalid UTF-8 becomes accepted JSON', transport,
     'fatal: true, ignoreBOM: true', 'fatal: false, ignoreBOM: true', wire, 'utf8 response'),
    ('late complete response borrows timer delay', transport,
     'finish(active() ? value : undefined)', 'finish(value)', wire, 'own monotonic deadline'),
    ('background budget is silently clipped to client budget', transport,
     'Math.min(4500, timeoutMs)', 'Math.min(500, timeoutMs)', wire, 'explicit recovery budget 1500'),
    ('explicit budget loses its hard cap', transport,
     'Math.min(4500, timeoutMs)', 'Math.min(45000, timeoutMs)', wire, 'explicit recovery budget 10000'),
    ('owner callbacks repeat full disk proofs', catalog,
     'const scope = boundary(allocation, current, verify)', 'const scope = boundary(allocation, () => { verify(); return current() })', storage, 'keeps recovered outbox owner checks'),
    ('confirmed publication never yields to eager control', 'src/engines/kit/nativeHookJournal.ts',
     'owner && performance.now() - owner.yieldedAt >= 20', 'false', storage, 'yields confirmed publication work'),
    ('yield borrows an identical replacement publication', 'src/engines/kit/nativeHookJournal.ts',
     'readFence(() => { verify(); published.verify(); owner.check() })', 'readFence(() => { verify(); owner.check() })', storage, 'exact published witness'),
    ('wrong-directory acquisition is retained', catalog,
     'try { route(); checkRoot(); return opened }', 'try { checkRoot(); return opened }', storage, 'transient ancestor redirection'),
    ('orphan journal authority hidden by listing', catalog,
     'witnesses|bootstrap|authority|seal', 'witnesses|bootstrap|seal', storage, 'orphan .history.authority'),
    ('case-insensitive retained slot appears absent', catalog,
     'const name = entry.name.toLowerCase()', 'const name = entry.name', storage, 'case variants'),
    ('publication authority disconnected', files,
     'options.verify?.(); check()', 'check()', files_unit, 'publication authority'),
    ('removal skips its final authority observation', files,
     'attempt.verify()\n      if (content !== null) unlinkSync(target)', 'attempt.check()\n      if (content !== null) unlinkSync(target)', files_unit, 'final removal observation'),
    ('joining caller skips its own initial authority', files,
     'verifyRoutes()\n  options.verify?.()', 'verifyRoutes()', files_unit, 'publisher authority revoked before joining'),
    ('joining caller borrows the producer final authority', files,
     '    options.verify?.()\n    if (options.current?.() === false)', '    if (options.current?.() === false)', files_unit, 'publisher authority revoked while waiting'),
    ('full publication proof borrows an expired owner', files,
     'options.verify?.(); check()', 'options.verify?.()', files_unit, 'revoked by the full publication authority check itself'),
    ('journal forgets its retained publication authority', 'src/engines/kit/nativeHookJournal.ts',
     'verify: () => readFence(() => { verify(); (owner?.check ?? check)() })', 'verify: () => {}', journal_unit, 'retains publication authority through a held claim flush'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(target, pattern=''):
    try:
        return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', target, '--maxWorkers=1',
                               *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                              text=True, capture_output=True, timeout=65)
    except subprocess.TimeoutExpired as error:
        raise SystemExit('Timed out: ' + target + '\n' + (error.stdout or b'').decode(errors='replace')
                         + (error.stderr or b'').decode(errors='replace')) from error


for target, pattern in [(unit, ''), (wire, ''), (http, 'starts retained client replay'),
                        (files_unit, 'publication authority|publisher authority'),
                        (journal_unit, 'retains publication authority through a held claim flush'),
                        (storage, 'transient ancestor redirection|orphan .history.authority|case variants|keeps recovered outbox owner checks|yields confirmed publication work|exact published witness')]:
    baseline = run(target, pattern)
    if baseline.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native replay baselines passed', flush=True)
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
