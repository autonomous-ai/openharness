"""Reserved native launch choices cannot be reconstructed from newer defaults."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
intent = 'src/lib/nativeTurnIntent.ts'
intent_spec = 'src/lib/nativeTurnIntent.spec.ts'
writer = 'src/engines/kit/nativeRearmWitness.ts'
writer_spec = 'src/engines/kit/nativeRearmWitness.spec.ts'
proof = 'src/engines/kit/nativeRearmProof.ts'
proof_spec = 'src/engines/kit/nativeRearmProof.spec.ts'
mutations = [
    ('original permission mode is ignored', intent, [('row.permissionMode ?? null', 'null')], intent_spec, 'binds a durable target'),
    ('original bypass permission is ignored', intent, [('row.bypassPermission === true', 'false')], intent_spec, 'binds a durable target'),
    ('incomplete reservation gets current defaults', intent, [('if (!rearm?.source) return null', 'if (!rearm) return null')], intent_spec, 'does not reconstruct'),
    ('omitted permission becomes an explicit choice', intent,
     [("...(rearm.permissionMode === undefined ? {} : { permissionMode: rearm.permissionMode })", "permissionMode: rearm.permissionMode ?? 'ask'")],
     intent_spec, 'reconstructs the immutable'),
    ('reservation source can be changed', intent,
     [('reserved.source, reserved.permissionMode', 'undefined, reserved.permissionMode'),
      ('proposed.source, proposed.permissionMode', 'undefined, proposed.permissionMode')], intent_spec, 'reconstructs the immutable'),
    ('reservation permission can be changed', intent,
     [('reserved.source, reserved.permissionMode', 'reserved.source, undefined'),
      ('proposed.source, proposed.permissionMode', 'proposed.source, undefined')], intent_spec, 'reconstructs the immutable'),
    ('writer ignores reserved source', writer,
     [('|| request.source !== rearm.source || rearm.source !== undefined && value.source !== rearm.source', '')],
     writer_spec, 'holds a source change'),
    ('writer ignores reserved permissions', writer, [('|| request.permissionMode !== rearm.permissionMode', '')],
     writer_spec, 'holds a permission change'),
    ('replacement proof ignores reserved options', proof,
     [('|| intent.source !== rearm.source || intent.permissionMode !== rearm.permissionMode', '')],
     proof_spec, 'proves replacement only'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(spec, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for spec in [intent_spec, writer_spec, proof_spec]:
    result = run(spec)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Reserved-request baselines passed', flush=True)
failures = []
for label, path, changes, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    changed = original
    for before, after in changes:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        source.write_text(changed)
        result = run(spec, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Unproven mutations: ' + ', '.join(failures))
print(f'All {len(mutations)} reserved-request faults caught by assertions', flush=True)
