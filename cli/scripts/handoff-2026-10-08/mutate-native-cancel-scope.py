"""Cancel must retain the original engine's PID view, never a later substitute."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
owner = 'src/engines/kit/nativeHookOwner.ts'
owner_spec = 'src/engines/kit/nativeHookOwner.spec.ts'
intent = 'src/lib/nativeTurnIntent.ts'
intent_spec = 'src/lib/nativeTurnIntent.spec.ts'
cancel = 'src/core/turns/nativeCancel.ts'
cancel_spec = 'src/core/turns/nativeCancel.spec.ts'
http = 'src/hookServer.ts'
http_spec = 'src/hookServer.nativeProtocol.spec.ts'
mutations = [
    ('Cancel drops captured PID view', cancel,
     '...(owner?.namespace === undefined ? {} : { namespace: owner.namespace }), ', '',
     cancel_spec, 'copies the previously confirmed PID view'),
    ('Cancel identity ignores its original namespace', intent,
     'value.request.frontier.digest, value.namespace]', 'value.request.frontier.digest]',
     intent_spec, 'retains canonical'),
    ('Cancel accepts incomplete scope', intent,
     "Object.hasOwn(cancel, 'namespace') && !nativeTurnProcess({ processKey: cancel.processKey, namespace: cancel.namespace })",
     'false', intent_spec, 'refuses incomplete or noncanonical Cancel scope'),
    ('Cancel accepts another spelling of the original PID', intent,
     ' || String(Number(parts[2])) !== parts[2]', '', intent_spec, 'refuses incomplete or noncanonical Cancel scope'),
    ('generation owner scopes the wrong directory', owner,
     'const before = await scope(root, budget, helpers)', "const before = await scope(root + '/other', budget, helpers)",
     owner_spec, 'captures a historical PID view'),
    ('generation owner accepts a foreign initial boot', owner,
     'before.boot !== boot || ', '', owner_spec, 'foreign initial boot scope'),
    ('generation owner discards expected PID scope', owner,
     " || original && 'namespace' in original && original.namespace !== namespace", '',
     owner_spec, 'foreign initial namespace scope'),
    ('generation owner accepts a changed boot', owner,
     'after.boot !== boot || ', '', owner_spec, 'holds boot changes across generation'),
    ('generation owner accepts a changed PID view', owner,
     'after.namespace !== namespace || ', '', owner_spec, 'holds namespace changes across generation'),
    ('generation owner accepts a different volume', owner,
     ' || after.storage !== storage', '', owner_spec, 'holds storage changes across generation'),
    ('generation owner loses the original process after scope waits', owner,
     'const final = await observe(row, first, budget, boot)', 'const final = first',
     owner_spec, 'holds pid changes across generation'),
    ('generation owner drops canonical birth validation', owner,
     '!validNativeHookWriter({ boot, namespace, pid: row.processIdentity!.pid, birth: parts[3] })',
     'false', owner_spec, 'holds birth changes across generation'),
    ('generation owner grants expired scope after cleanup', owner,
     '      budget.step()\n      return result', '      return result', owner_spec, 'holds first-close failure'),
    ('generation owner leaks its first descriptor on close failure', owner,
     'try { after?.close() } finally { before.close() }', 'after?.close(); before.close()',
     owner_spec, 'holds close-error failure'),
    ('generation source omits its scoped owner reader', http,
     'handlers.readNativeGenerationOwner ?? handlers.readNativeHookOwner', 'handlers.readNativeHookOwner',
     http_spec, 'pins the original generation namespace'),
    ('generation source omits the original namespace', http,
     '...(namespace === undefined ? {} : { namespace }), ', '', http_spec, 'pins the original generation namespace'),
    ('generation source accepts another original process', http,
     'native.key !== original.processKey || ', '', http_spec, 'holds key final generation scope'),
    ('generation source accepts a different original image', http,
     'native.evidence !== context.owner?.evidence', 'false', http_spec, 'holds image final generation scope'),
    ('generation source accepts missing or invalid PID scope', http,
     '(handlers.readNativeGenerationOwner || native.namespace !== undefined)\n            && !nativeTurnProcess({ processKey: native.key, namespace: native.namespace })',
     'false', http_spec, 'holds (missing|invalid) final generation scope'),
    ('generation source silently adopts another PID view', http,
     'if (expected !== undefined && namespace !== expected)', 'if (false)',
     http_spec, 'pins the original generation namespace'),
    ('generation recovery drops the saved Cancel PID view', http,
     'return context.namespace ?? saved', 'return context.namespace',
     http_spec, 'recovers the original PID view from a saved Cancel'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'
selected = sys.argv[2:]
if selected:
    assert all(label in [row[0] for row in mutations] for label in selected), 'Unknown mutation selection'
    mutations = [row for row in mutations if row[0] in selected]


def run(files, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=360)


baselines = [(list(dict.fromkeys(row[4] for row in mutations)), '|'.join(dict.fromkeys(row[5] for row in mutations)))] if selected else [
    ([owner_spec, intent_spec, cancel_spec, http_spec], '.')]
for files, pattern in baselines:
    result = run(files, pattern)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native Cancel scope baseline passed', flush=True)
failures = []
for label, path, before, after, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
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
