"""Cancel must retain the original prefix and publication authority across restart."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
journal = 'src/engines/kit/nativeHookJournal.ts'
schema = 'src/engines/kit/nativeGenerationCancellation.ts'
source = 'src/core/turns/nativeGenerationSource.ts'
projection = 'src/core/turns/nativeGenerations.ts'
unit = 'src/engines/kit/nativeHookCancellation.spec.ts'
source_unit = 'src/core/turns/nativeGenerationSource.spec.ts'
projection_unit = 'src/core/turns/nativeGenerations.spec.ts'
process_unit = 'src/engines/kit/nativeHookJournal.process.spec.ts'
mutations = [
    ('Cancel follows mutable caller data', journal, [
        ('const request = structuredClone(input)', 'const request = input')], unit, 'immutable original request'),
    ('Cancel broadens an old prefix to newer observations', schema, [
        ('positions.get(fact.id)! <= request.frontier.index', 'true')], unit, 'older prefix exact'),
    ('Cancel crosses the original owner and conversation', schema, [
        ('&& fact.agentId === request.agentId && fact.conversationId === request.conversationId', '')], unit, 'all original nonterminal targets'),
    ('Cancel accepts an invented prefix digest', schema, [
        ('|| (request.frontier.index >= 0 && chain[request.frontier.index] !== request.frontier.digest)', '')], unit, 'invented prefix'),
    ('recovery duplicates synthetic tombstones', journal, [
        ('if (!cancelled.has(generationScope(fact))) addGeneration(fact, index)', 'addGeneration(fact, index)')], unit, 'deduplicates tombstones globally'),
    ('changed request is accepted under the old cancellation ID', journal, [
        ("if (JSON.stringify(known) !== JSON.stringify(request)) held('NATIVE_CANCELLATION_CONFLICT')", '')], unit, 'refuses changed'),
    ('generation intake spends the control reserve', journal, [
        ('const control = Number(!before.cancellations.size)', 'const control = 0')], unit, 'terminal record and byte reservation'),
    ('early Cursor intake spends the control reserve', journal, [
        ("const control = Number(kind === 'effects' && !before.cancellations.size && (before.controlReserved || intake.payload.engine === 'cursor'))",
         'const control = 0')], unit, 'before any generation is known'),
    ('same-byte replacement inherits cancellation publication authority', journal, [
        ('const verifyPublished = await append(before, event, !before.controlReserved)',
         'await append(before, event, !before.controlReserved); const verifyPublished = () => {}')], unit, 'replaced before reconstruction'),
    ('append adopts replacement bytes after original publication', journal, [
        ('return published.verify', 'return () => {}')], unit, 'publication proof before append'),
    ('physical dispatch omits its final owner fence', journal, [
        ('const verify = () => { check(); verifyPublished(); after.verify(); checkOwner() }',
         'const verify = () => { check(); verifyPublished(); after.verify() }')], unit, 'final disk read at both dispatch boundaries'),
    ('one cancellation dispatches twice', journal, [
        ("if (used) held('the cancellation dispatch was already consumed')", '')], unit, 'all original nonterminal targets'),
    ('later observations inherit the original interrupt', journal, [
        ("if (before.frontier.index !== request.frontier.index || before.frontier.digest !== request.frontier.digest\n              || after.length !== before.length + 1) held('the cancellation dispatch frontier changed')", '')], unit, 'older prefix exact'),
    ('a later append does not revoke dispatch', journal, [
        ('const verify = () => { check(); verifyPublished(); after.verify(); checkOwner() }',
         'const verify = () => { check(); verifyPublished(); checkOwner() }')], unit, 'one-use dispatch after append'),
    ('source drops an empty or rebound cancellation barrier', source, [
        ('facts: Object.freeze(facts), frontier, cancellations, verify',
         'facts: Object.freeze(facts), frontier, cancellations: Object.freeze([]), verify')], source_unit, 'empty cancellation barrier'),
    ('projection admits late activity after Cancel', projection, [
        ("selection: cancellations.length ? 'cancelled' :", 'selection:')], projection_unit, 'incarnation barrier'),
    ('a later request borrows reserved terminal staging', journal, [
        ('const verifyPublished = await append(before, event, !before.controlReserved)',
         'const verifyPublished = await append(before, event, false)')], process_unit, 'reserved staging for the first cancellation'),
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


baseline = run([unit, source_unit, projection_unit])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Cancellation storage and control baseline passed', flush=True)
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
