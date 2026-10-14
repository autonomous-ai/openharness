"""Original pane/server provenance must survive exec and fail closed on change."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
writer = 'src/engines/kit/nativeRearmWitness.ts'
unit = 'src/engines/kit/nativeRearmWitness.spec.ts'
process = 'src/engines/kit/nativeRearmWitness.process.spec.ts'
storage = 'src/lib/agentCreationReceipt.nativeRearm.spec.ts'
receipt = 'src/lib/agentCreationReceipt.ts'
allocation = 'src/lib/nativeLaunchAllocation.ts'
schema = 'src/lib/nativeLaunchAllocation.spec.ts'
mutations = [
    ('malformed allocation is accepted', receipt,
     "    && (!Object.hasOwn(value, 'allocation') || !!parseNativeLaunchAllocation(value.allocation, value))", '',
     storage, 'refuses null allocation metadata before'),
    ('publication ignores original launch token', receipt,
     ' || owner.allocation && owner.allocation.token !== source.receipt.request.launchToken', '',
     storage, 'refuses token allocation metadata before'),
    ('cold readers ignore original launch token', receipt,
     '    && (!value.process.allocation || value.process.allocation.token === launchToken)', '',
     storage, 'every cold receipt reader rejects coherently checksummed token'),
    ('reader forgets durable allocation', receipt,
     "...(part.process.allocation\n      ? { allocation: parseNativeLaunchAllocation(part.process.allocation, part.process)! } : {})",
     'allocation: undefined', storage, 'retains original allocation metadata through'),
    ('nested root is mutable', allocation,
     'root: Object.freeze({ ...value.root })', 'root: { ...value.root }', schema, 'copies and freezes'),
    ('foreign process scope accepted', allocation,
     '    && allocation.root.boot === engine.boot && allocation.root.namespace === engine.namespace', '',
     schema, 'rejects a coherent foreign'),
    ('root identity does not match pane PID', allocation,
     ' || value.root.pid !== value.rootPid', '', schema, 'rejects rootPid'),
    ('pane root is not server child', writer,
     ' || root.parentPid !== serverPid', '', unit, 'refuses the initial root-parent'),
    ('server image is not checked', writer,
     ' || server.imagePath !== realpathSync(placement.binary)', '', unit, 'refuses the initial server-image'),
    ('caller changes before quartet', writer,
     ' || controlIdentity(observed.rows.get(caller)!) !== parentIdentity', '', unit, 'refuses the initial caller'),
    ('writer changes before quartet', writer,
     ' || controlIdentity(observed.rows.get(self)!) !== childIdentity', '', unit, 'refuses the initial child'),
    ('pane query does not reprove live server', writer,
     "          if (!fresh || controlIdentity(fresh) !== serverIdentity) return held('original tmux server changed')",
     '', unit, 'refuses a replaced server during the initial'),
    ('released allocation grants exec', writer,
     "        if (state !== 'active') return held('original pane allocation is no longer active')",
     '', unit, 'never grants exec for an initially released'),
    ('pane lifetime is not rechecked after sync', writer,
     '    await verifyPane?.()', '', unit, 'rechecks released pane ownership after'),
    ('final quartet ignores pane ancestry', writer,
     'original && [...original].some(([pid, identity]) => !final.rows.get(pid) || controlIdentity(final.rows.get(pid)!) !== identity)',
     'false', unit, 'rechecks the original pane ancestry at final PID'),
    ('binary changes during final wait', writer,
     '    if (placement) verifyNativeLaunchProof({ ready: true, command: placement.binary, identity: placement.identity, files: [] }, budget)',
     '', unit, 'rechecks the retained tmux executable after'),
    ('process witness omits placement', writer,
     '{ boot, namespace, pid: caller, birth: owner.birth, ...(allocation ? { allocation } : {}) }',
     '{ boot, namespace, pid: caller, birth: owner.birth }', unit, 'retains the original pane root and server before'),
    ('old artifact can omit pane recording', writer,
     "prepareNativeHookArtifact(moduleUrl, undefined, undefined, 'allocation')",
     'prepareNativeHookArtifact(moduleUrl, undefined, undefined, true)', unit, 'requires the explicit writer capability'),
    ('wrapper omits version two witness', 'src/lib/engineLaunch.ts',
     'nativeRearmExecCommand(witness, { binary: tmuxBinary, owner: harnessPaneOwner(env.ADAPTER_DATA_DIR) })',
     'nativeRearmExecCommand(witness)', process, 'the existing top-level wrapper'),
]
selected = sys.argv[2:]
if selected:
    assert set(selected) <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(files, pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=120)


for _, path, before, _, _, _ in mutations:
    assert (cli / path).read_text().count(before) == 1, (path, before)
baseline = run(list(dict.fromkeys(row[4] for row in mutations)), '|'.join(row[5] for row in mutations))
if baseline.returncode:
    raise SystemExit('Healthy pane witness cases failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Healthy native pane witness wiring cases passed', flush=True)
failures = []
for label, path, before, after, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    try:
        source.write_text(original.replace(before, after))
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
print(f'All {len(mutations)} native pane witness faults caught by assertions', flush=True)
