"""Native observations must precede binding and never inherit legacy Stop authority."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
server = 'src/hookServer.ts'
mapping = 'src/engines/kit/nativeHookGeneration.ts'
http = 'src/hookServer.nativeProtocol.spec.ts'
unit = 'src/engines/kit/nativeHookGeneration.spec.ts'
selected = ('native Stop before binding|generation input before effects|interrupted generation write|'
            'restored source when|source consumer fails|original native process proof|lost its original retained registration|'
            'both generation copies disappear|reprobes native birth|matching native Stop at|'
            'interrupted Stop intake|ordinary and direct evidence|fresh native authority|fresh generation authority')
mutations = [
    ('native observation is dropped before binding', server, [
        ('if (generation) await context.journal.recordGeneration(generation)', '')], http, 'native Stop before binding'),
    ('generation Stop enters legacy session-wide handling', server, [
        ('const carriesStop = !carriesGeneration && !!nativeDeliveryId', 'const carriesStop = !!nativeDeliveryId')], http, 'native Stop before binding'),
    ('attach is released before generation restoration', server, [
        ('      ready(context, !pending)\n', ''),
        ('    const pending = !!snapshot.active || [...snapshot.deliveries.values()].some(delivery => !delivery.result)',
         '    const pending = !!snapshot.active || [...snapshot.deliveries.values()].some(delivery => !delivery.result)\n    ready(context, !pending)')], http, 'native Stop before binding'),
    ('missing eager consumer still accepts generation intake', server, [
        ("if (!handlers.onNativeGenerations) throw Error('Native generation control is unavailable.')", '')], http, 'generation input before effects'),
    ('legacy endpoint accepts unowned generation fields', 'src/engines/kit/nativeHookBody.ts', [
        ('if (body.generationId !== undefined && !native) return false', '')], http, 'generation input before effects'),
    ('effect proof omits the complete frontier', server, [
        ('        retained.verify()\n        verifyNativeOwner()', '        verifyNativeOwner()')], http, 'restored source when'),
    ('effect proof follows a rebound conversation', server, [
        ('latest.sessionId !== original.sessionId || durableKey(latest)', 'durableKey(latest)')], http, 'restored source when'),
    ('effect proof omits original process authority', server, [
        ('        retained.verify()\n        verifyNativeOwner()', '        retained.verify()')], http, 'original native process proof'),
    ('unjoined native facts enter eager control', server, [
        ('if (!intake || JSON.stringify(nativeHookGeneration(intake)) !== JSON.stringify(fact)) {', 'if (false) {')], http, 'lost its original retained registration'),
    ('submission is mistaken for execution', mapping, [
        ("body.hookEvent === 'beforeSubmitPrompt' ? 'submitted'", "body.hookEvent === 'beforeSubmitPrompt' ? 'activity'")], unit, 'maps native'),
    ('native abort is reported as completion', mapping, [
        ("body.status === 'aborted' ? 'aborted'", "body.status === 'aborted' ? 'completed'")], unit, 'preserves the native'),
    ('binding proceeds without its original generation fact', server, [
        ('if (JSON.stringify(snapshot.generations.get(generation.id)) !== JSON.stringify(generation)) {', 'if (false) {')], http, 'both generation copies disappear before claim'),
    ('claim loses the original generation record proof', server, [
        ('        verifyGeneration()', '')], http, 'both generation copies disappear after claim', [
        ('src/engines/kit/nativeHookJournal.ts', [
            ('const verify = () => { before.verifyRecords(); verifyOutside(); verifyMirror(); record.verify(); witness.verify() }',
             'const verify = () => { verifyOutside(); verifyMirror(); record.verify(); witness.verify() }')])]),
    ('kernel identity is not refreshed after confirmation', server, [
        ('if (handlers.readNativeHookOwner) verifyNativeOwner = (await handlers.readNativeHookOwner(row, context.owner)).verify', '')], http, 'reprobes native birth'),
    ('matching Stop depends on new normal intake', server, [
        ('if (await retainBoundGenerationStop(', 'if (false && await retainBoundGenerationStop(')], http, 'matching native Stop at'),
    ('a pending intake switches to direct terminal representation', server, [
        ('if (snapshot.deliveries.has(id)) return false', '')], http, 'interrupted Stop intake'),
    ('completed intake ignores another original generation namespace', server, [
        ('if (new Set([...matches.map(match => match.key), ...generationMatches.map(match => match.key)]).size > 1)',
         'if (false)')], http, 'ordinary and direct evidence'),
    ('successor queues ahead of its missing durable predecessor', server, [
        ("if (delivery.result || delivery.intake.conversationId !== (body.sessionId ?? '') || history.records.has(id)) continue",
         'if (true) continue')], http, 'interrupted Stop intake'),
    ('direct Stop races an existing intake', 'src/engines/kit/nativeHookJournal.ts', [
        ("if (fact.source.type === 'native' && fact.source.identityV1 !== undefined && before.deliveries.has(fact.source.deliveryId))",
         'if (false)')], 'src/engines/kit/nativeHookJournal.spec.ts', 'original intake representation'),
    ('intake races an existing direct Stop', 'src/engines/kit/nativeHookJournal.ts', [
        ("if ([...before.generations.values()].some(fact => fact.source.type === 'native'\n        && fact.source.identityV1 !== undefined && fact.source.deliveryId === intake.id))",
         'if (false)')], 'src/engines/kit/nativeHookJournal.spec.ts', 'original direct representation'),
    ('fresh read revokes readiness as a side effect', server, [
        ('if (publish) ready(context, false)', 'ready(context, false)')], http, 'fresh native authority'),
    ('fresh read replays the controller callback', server, [
        ('if (publish) handlers.onNativeGenerations!', 'handlers.onNativeGenerations!')], http, 'fresh native authority'),
    ('fresh read republishes admission and attach state', server, [
        ('nativeGenerationState(input, false)', 'nativeGenerationState(input, true)')], http, 'fresh native authority'),
    ('fresh read lends authority during pending admission', server, [
        ("if (state.pending) throw new IdentityReadUnavailable('native generation admission is still pending')", '')], http, 'fresh generation authority while pending'),
    ('fresh read follows a mutable requested binding', server, [
        ('const original = Object.freeze({ ...input })\n    const row', 'const original = input\n    const row')], http, 'fresh native authority'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(specs, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=70)


for specs, pattern in [([http], selected), ([unit], '')]:
    baseline = run(specs, pattern)
    if baseline.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native generation HTTP baselines passed', flush=True)
failures = []
selected_mutations = os.environ.get('NATIVE_GENERATION_MUTATIONS')
for label, filename, edits, spec, pattern, *additional in mutations:
    if selected_mutations and label not in selected_mutations.split('|'):
        continue
    files = [(filename, edits), *(additional[0] if additional else [])]
    originals = {}
    try:
        for filename, edits in files:
            path = cli / filename
            original = path.read_text()
            originals[path] = original
            changed = original
            for before, after in edits:
                assert changed.count(before) == 1, (label, changed.count(before))
                changed = changed.replace(before, after)
            path.write_text(changed)
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        for path, original in originals.items():
            path.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
