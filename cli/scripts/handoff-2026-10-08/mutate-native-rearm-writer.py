"""The recorded original process, not an argv retry, must own native relaunch."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
writer = 'src/engines/kit/nativeRearmWitness.ts'
unit = 'src/engines/kit/nativeRearmWitness.spec.ts'
process = 'src/engines/kit/nativeRearmWitness.process.spec.ts'
storage = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
mutations = [
    ('saved target is not retained', writer,
     "\n    || nativeTurnTarget(selected[0] as unknown as RegisteredSession) !== input.control.rearm!.target", '', unit,
     'holds pane persisted control'),
    ('source accepts array coercion', writer,
     "value.source !== 'live' && value.source !== 'saved'", "!['live', 'saved'].includes(String(value.source))", unit,
     'refuses source-array writer input'),
    ('writer parent is not checked', writer,
     "if (!child || child.parentPid !== caller)", 'if (!child)', unit,
     'does not publish for an initially reparent'),
    ('shell image is not checked', writer,
     'if (!owner || owner.imagePath !== shell)', 'if (!owner)', unit,
     'does not publish for an initially image'),
    ('final paired incarnation proof is skipped', writer,
     'controlIdentity(currentChild) !== childIdentity || controlIdentity(currentOwner) !== parentIdentity',
     'false', unit, 'holds parent changes during the final'),
    ('dependencies are not rechecked after the final wait', writer,
     '    verifyNativeLaunchProof(input.dependencies, budget)\n    permit.verify(); verifyScope(); budget.step()',
     '    permit.verify(); verifyScope(); budget.step()', unit, 'holds settings changes during the final'),
    ('original witness permit is dropped', writer,
     '    permit.verify(); verifyScope(); budget.step()', '    verifyScope(); budget.step()', unit,
     'holds witness changes during the final'),
    ('old no-op client can grant exec', writer,
     "prepareNativeHookArtifact(moduleUrl, undefined, undefined, 'allocation')",
     'prepareNativeHookArtifact(moduleUrl, undefined, undefined, false)', unit,
     'requires the explicit writer capability'),
    ('writer error inherits success', 'src/nativeHookEntry.ts',
     '  process.exitCode = 75', '  process.exitCode = 0', process,
     'an invalid writer invocation'),
    ('writer refusal still execs', writer,
     '''    'if [ "$harness_rearm_status" != 0 ] || [ "$harness_rearm_interrupted" != 0 ]; then',''',
     "    'if false; then',", process, 'a failure writer'),
    ('signal arrives after gate but before reset', writer,
     "    'trap - INT QUIT HUP TERM',\n    'if [ \"$harness_rearm_status\" != 0 ] || [ \"$harness_rearm_interrupted\" != 0 ]; then',",
     "    'if [ \"$harness_rearm_status\" != 0 ] || [ \"$harness_rearm_interrupted\" != 0 ]; then',",
     process, 'a before-reset writer',
     ("    'shift 3',", "    'trap - INT QUIT HUP TERM',\n    'shift 3',")),
    ('engine launch omits the writer', 'src/lib/engineLaunch.ts',
     'engineRunScript(engine, tmuxBinary, witness && nativeRearmExecCommand(witness, { binary: tmuxBinary, owner: harnessPaneOwner(env.ADAPTER_DATA_DIR) }))',
     'engineRunScript(engine, tmuxBinary)', process,
     'the existing top-level wrapper'),
    ('writer omits the original PID namespace', writer,
     '{ boot, namespace, pid: caller, birth: owner.birth, ...(allocation ? { allocation } : {}) }',
     '{ boot, pid: caller, birth: owner.birth, ...(allocation ? { allocation } : {}) }',
     unit, 'hands only the original'),
    ('writer accepts a changed kernel scope', writer,
     'finalScope.boot !== boot', 'false', unit, 'holds a changed boot scope'),
    ('writer accepts a changed PID view', writer,
     'finalScope.namespace !== namespace', 'false', unit, 'holds a changed namespace scope'),
    ('writer accepts a different storage scope', writer,
     'finalScope.storage !== storage', 'false', unit, 'holds a changed storage scope'),
    ('writer drops final scope retention', writer,
     'finalScope?.verify(receiptDirectory); ', '', unit, 'retains the final scope through'),
    ('writer proves the parent instead of the receipt volume', writer,
     "originalScope = await scope(receiptDirectory, budget, helpers)",
     "originalScope = await scope(input.dataDir, budget, helpers)", unit, 'holds when the witness directory'),
    ('writer grants exec after cleanup crosses the deadline', writer,
     '  budget.step()\n  return true\n}', '  return true\n}', unit,
     'descriptor close crosses the deadline'),
    ('writer leaks original scope when final close throws', writer,
     'try { finalScope?.close() } finally { originalScope.close() }',
     'finalScope?.close(); originalScope.close()', unit, 'a final descriptor close failure'),
    ('witness permits another spelling of the same birth', 'src/lib/agentCreationReceipt.ts',
     'String(Number(text)) === text', 'true', storage, 'rejects noncanonical birth'),
    ('witness permits ambiguous PID namespace spelling', 'src/lib/agentCreationReceipt.ts',
     '/^linux:(?:0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}$/.test(value.namespace)',
     '/^.*$/.test(value.namespace)', storage, 'rejects noncanonical birth'),
    ('witness permits overflowing PID namespace identity', 'src/lib/agentCreationReceipt.ts',
     ' && value.namespace.split(\':\').slice(1).every(part => BigInt(part) <= 0xffffffffffffffffn)',
     '', storage, 'rejects noncanonical birth'),
]
# Linux /bin/sh can be dash, which never imports Bash startup files. Darwin's
# concrete Bash image supplies the causal startup-file/function refusal test.
if sys.platform == 'darwin':
    mutations.append(('inherited shell startup can run before handoff', writer,
                      "[witnessShell(), '-p', '-c', script", "[witnessShell(), '-c', script", process,
                      'the fixed handoff ignores'))

environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
selected = sys.argv[2:]
if selected:
    assert set(selected) <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=180)


result = run(list(dict.fromkeys(row[4] for row in mutations)), '|'.join(row[5] for row in mutations)) if selected else run([unit, process, storage])
if result.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native rearm writer baseline passed', flush=True)
failures = []
for label, path, before, after, spec, pattern, *extra in mutations:
    source = cli / path
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        changed = original.replace(before, after)
        for needle, replacement in extra:
            assert changed.count(needle) == 1, (label, needle)
            changed = changed.replace(needle, replacement)
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
