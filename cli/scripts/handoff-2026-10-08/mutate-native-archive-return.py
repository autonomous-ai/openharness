"""Stop must durably return exactly one native visit before removing its route."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
archive = 'src/lib/stoppedAgents.ts'
spec = 'src/lib/nativeArchiveReturn.spec.ts'
witness = 'src/engines/kit/nativeRearmWitness.ts'
witness_spec = 'src/engines/kit/nativeRearmWitness.spec.ts'
mutations = [
    ('the witness executes a live-owned returning archive', witness,
     "archive.version === 3 && archive.nativeReturn.phase === 'saved'",
     "archive.version === 3", witness_spec, 'saved witness refuses returning'),
    ('the witness accepts another visit agent', witness,
     '&& (archive.version !== 3 || archive.nativeReturn.link.agentId === saved.agentId)',
     '', witness_spec, 'saved witness refuses foreign'),
    ('a legacy envelope erases the witness ownership role', 'src/lib/nativeArchive.ts',
     "raw.version === 1 && !Object.hasOwn(raw, 'nativeTransfer') && !Object.hasOwn(raw, 'nativeReturn')",
     'raw.version === 1', witness_spec, 'saved witness refuses legacy'),
    ('return skips saved ownership publication', registry,
     'saved = archive.complete(retirement, { verifyBefore: verify, verifyAfter: () => { source.verify(); current() }, current })',
     'saved = archive.session', spec, 'checkpoints before retirement'),
    ('retirement drops its exact process proof binding', registry,
     "if (binding.target !== target || binding.controlFingerprint !== controlFingerprint) {\n      throw new IdentityReadUnavailable('the stopped process proof belongs to a different native visit')",
     "if (false) {\n      throw new IdentityReadUnavailable('the stopped process proof belongs to a different native visit')", spec, 'rejects a stopped proof for another'),
    ('retirement loses the final stopped-process verifier', registry,
     'verifyPublished(); source.verifyDirectory(); checkpoint(); verifyStopped(); current()',
     'verifyPublished(); source.verifyDirectory(); checkpoint(); current()', spec, 'rechecks stopped-process evidence after'),
    ('retirement final caller fence skips owner recheck', registry,
     'const current = () => { unchanged(); fence(); stoppedCurrent(); unchanged() }',
     'const current = () => { unchanged(); fence(); stoppedCurrent() }', spec, 'final retirement guard'),
    ('cleanup final caller fence skips owner recheck', registry,
     "const current = () => { unchanged(); fence(); unchanged() }\n    const verify = () => { source.verify(); archive.verify(); current() }",
     "const current = () => { unchanged(); fence() }\n    const verify = () => { source.verify(); archive.verify(); current() }", spec, 'final cleanup guard'),
    ('discovery reopens a retired route', registry,
     "if (input.agentId && this.agents.get(input.agentId)?.nativeRetirement || runtimes.some(runtime =>\n      this.agents.get(this.runtimeIndex.get(terminalRouteKey(runtime)) ?? '')?.nativeRetirement)) return null",
     '', spec, 'discovery cannot reopen a loaded retirement'),
    ('cleanup overwrites later saved edits with the old checkpoint', archive,
     "publish(retained.session, { ...closing, phase: 'saved' }, authority)",
     "publish({ ...retained.session, cwd: original.cwd, nativeControl: original.nativeControl }, { ...closing, phase: 'saved' }, authority)",
     spec, 'saved edits survive uncertain cleanup'),
    ('return forgets the actual publisher before its subsequent inspection', archive,
     'this.uncertainTransfers.set(original.agentId, { bytes, verifyPublished: publication!, verifyDirectory: before.verifyDirectory })\n          retained = this.inspectReturnSource(original)',
     'void publication\n          retained = this.inspectReturnSource(original)', spec, 'publisher through its first subsequent inspection'),
    ('return confirms an unrelated uncertain saved control', archive,
     "if (this.uncertain.has(original.agentId)) throw Error('Waiting for the original saved native control publication.')",
     '', spec, 'cleanup cannot confirm an uncertain saved Cancel'),
    ('uncertain pending retirement requires the obsolete saved checkpoint', registry,
     '!retained && creationFingerprint(archive.session) !== role.checkpoint',
     'creationFingerprint(archive.session) !== role.checkpoint', spec, 'uncertain pending retirement after newer saved edits'),
    ('uncertain pending retirement replaces its original candidate', registry,
     'const candidate: RegisteredSession = retained ?? { ...original, nativeControl: snapshot.nativeControl, nativeRetirement: role }',
     'const candidate: RegisteredSession = { ...original, nativeControl: snapshot.nativeControl, nativeRetirement: role }',
     spec, 'uncertain pending retirement after newer saved edits using the new snapshot'),
    ('pending abort trusts another stopped allocation', registry,
     "if (binding.target !== target || binding.controlFingerprint !== controlFingerprint) {\n      throw new IdentityReadUnavailable('the stopped allocation proof belongs to a different pending Resume')",
     "if (false) {\n      throw new IdentityReadUnavailable('the stopped allocation proof belongs to a different pending Resume')",
     spec, 'rejects a pending abort with'),
    ('pending abort loses its final allocation proof', registry,
     'verifyPublished(); source.verifyDirectory(); savedCheckpoint(); verifyStopped(); pendingCurrent()',
     'verifyPublished(); source.verifyDirectory(); savedCheckpoint(); pendingCurrent()', spec, 'rechecks stopped allocation'),
    ('pending abort accepts a successor archive role', archive,
     "current !== pendingAbort.priorRole && current !== creationFingerprint({ ...role, phase: 'saved' })",
     'false', spec, 'refuses a successor archive role'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(specs, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=120)


baseline = run([spec, witness_spec])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native archive return baseline passed', flush=True)
failures = []
for label, path, before, after, target, pattern in mutations:
    source = cli / path
    original = source.read_text()
    try:
        assert original.count(before) == 1, (label, original.count(before))
        source.write_text(original.replace(before, after))
        result = run([target], pattern)
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
print(f'All {len(mutations)} native archive return wiring faults caught by assertions', flush=True)
