"""Retained generation facts must carry real frontier and reservation authority."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
journal = 'src/engines/kit/nativeHookJournal.ts'
source = 'src/core/turns/nativeGenerationSource.ts'
schema = 'src/engines/kit/nativeGenerationFact.ts'
unit = 'src/engines/kit/nativeHookJournal.spec.ts'
source_unit = 'src/core/turns/nativeGenerationSource.spec.ts'
catalog = 'src/engines/kit/nativeHookCatalog.spec.ts'
mutations = [
    ('restoration drops native observations', journal, [
        ('addGeneration(event.fact, index)', '')], unit, 'immutable generation facts'),
    ('observation clears uncertain effect ownership', journal, [
        ('addGeneration(event.fact, index)', 'addGeneration(event.fact, index); active = undefined')], unit, 'immutable generation facts'),
    ('retention follows mutable caller data', journal, [
        ('const fact = structuredClone(input)', 'const fact = input')], unit, 'immutable generation facts'),
    ('phase identity forgets the endpoint', schema, [
        ("['native', source.deliveryId, source.wire.path]", "['native', source.deliveryId]")], unit, 'deduplicates exact generation phases'),
    ('one Cancel cannot revoke two scoped generations', schema, [
        ("['core', source.requestId, fact.agentId, fact.conversationId, fact.generationId]", "['core', source.requestId]")], unit, 'core Cancel request'),
    ('changed receipt content is accepted', journal, [
        ("if (JSON.stringify(known) !== JSON.stringify(fact)) held('NATIVE_GENERATION_CONFLICT')", '')], unit, 'deduplicates exact generation phases'),
    ('visible duplicate is acknowledged without confirmation', journal, [
        ('await before.confirm(); before.verify(); return', 'before.verify(); return')], unit, 'unconfirmed visible generation'),
    ('native input manufactures core cancellation', journal, [
        ("if (kind !== 'effects' || !validNativeGenerationFact(fact)) held('invalid native generation fact')",
         "if (kind !== 'effects') held('invalid native generation fact')")], unit, 'native input from manufacturing'),
    ('generation limit is checked too late', schema, [
        ('MAX_NATIVE_GENERATIONS = 512', 'MAX_NATIVE_GENERATIONS = 513')], unit, 'projection limit before retaining'),
    ('legacy intake spends generation reservations', journal, [
        ("const generations = [...nativeGenerationFactState(before.generations.values()).values()].filter(state => state === 'running').length",
         'const generations = 0')], unit, 'shares record and byte reservations'),
    ('normal generation facts spend reserved terminal staging', journal, [
        ("await append(before, { kind: 'generation', fact }, !reserved)", "await append(before, { kind: 'generation', fact }, false)")], catalog, 'matching native Stop and Cancel'),
    ('mirror repair lends its terminal lease to new intake', journal, [
        ("if (purpose === 'normal' && state.stagePurpose === 'terminal') held('terminal capacity cannot initialize a journal')", '')], catalog, 'terminal mirror-repair lease'),
    ('source uses leaf existence without a complete frontier', source, [
        ('const verifySnapshot = snapshot.verify.bind(snapshot)', 'const verifySnapshot = () => {}')], source_unit, 'real complete frontier'),
    ('source credits unconfirmed visible facts', source, [
        ('await confirmSnapshot()', '')], source_unit, 'disk confirmation is unavailable'),
    ('source follows a replacement confirmation callback', source, [
        ('await confirmSnapshot()', 'await snapshot.confirm()')], source_unit, 'original confirmation callback'),
    ('source copies facts after yielding', source, [
        ('await confirmSnapshot()\n      verify()', 'verify()'),
        ('const facts: NativeGenerationFact[] = []', 'await confirmSnapshot()\n      const facts: NativeGenerationFact[] = []')], source_unit, 'mutable snapshot'),
    ('source omits the post-confirmation frontier fence', source, [
        ('await confirmSnapshot()\n      verify()', 'await confirmSnapshot()')], source_unit, 'frontier changed after confirmation'),
    ('effect proof changes its process incarnation', source, [
        ("verifySnapshot()\n        if (snapshot.processKey !== original.processKey) held('the process incarnation changed')", 'verifySnapshot()')], source_unit, 'effect-time source proof'),
    ('foreign facts enter this conversation', source, [
        ('if (fact.agentId !== original.agentId || fact.conversationId !== original.sessionId) continue', '')], source_unit, 'reconstructs scoped Stop|foreign terminal fact'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(specs, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=75)


baseline = run([unit, source_unit])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native generation storage baseline passed', flush=True)
failures = []
for label, filename, edits, spec, pattern in mutations:
    path = cli / filename
    original = path.read_text()
    changed = original
    for before, after in edits:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        path.write_text(changed)
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
