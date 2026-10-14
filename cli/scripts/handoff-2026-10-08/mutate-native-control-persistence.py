"""Durable native Cancel cannot disappear or authorize an unproven replacement."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
proof = 'src/lib/nativeControlFile.ts'
unit = 'src/lib/registry.nativeControl.spec.ts'
intent = 'src/lib/nativeTurnIntent.ts'
intent_test = 'src/lib/nativeTurnIntent.spec.ts'
mutations = [
    ('reserved launch grants premature admission', intent,
     'if (!intent) return true', 'if (!intent || intent.rearm) return true', intent_test,
     'copies an immutable cancellation'),
    ('initial Cancel skips launch reservation', intent,
     'if (!previous) return !next.rearm && cancel()', 'if (!previous) return true', intent_test,
     'requires Cancel, original reservation'),
    ('old Cancel ID cancels replacement', intent,
     ' || next.cancel.request.requestId === previous.cancel.request.requestId', '', intent_test,
     'requires Cancel, original reservation'),
    ('uncertain Cancel rolls back', registry,
     'if (unconfirmed?.sticky && (!confirming || peerChanged))', 'if (false)', unit,
     'never rolls an uncertain Cancel'),
    ('stale peer deletes Cancel', registry,
     'if ((latest.get(baselineId)?.nativeControl || latest.get(baselineId)?.nativeAllocation)\n        && baselines.get(baselineId) !== rowFingerprint(latest.get(baselineId)))',
     'if (false)', unit, 'does not let a stale peer remove'),
    ('fresh read ignores saved binding', registry,
     ' || nativeTurnTarget(saved) !== target || rowFingerprint(saved.nativeControl) !== rowFingerprint(original.nativeControl)',
     '', unit, 'holds unavailable or changed durable binding'),
    ('load drops native control', registry,
     '          ...(raw.nativeControl ? { nativeControl: parseNativeTurnIntent(raw.nativeControl)! } : {}),',
     '', unit, 'keeps cancellation across registration'),
    ('private inspection outlives retained proof', proof,
     'verifyDirectory(); privateState(file, false)\n    retained.verify()',
     'retained.verify()\n    verifyDirectory(); privateState(file, false)', unit,
     'checks the retained file after all private-state inspection'),
    ('external fence changes commit owner', registry,
     'const verify = () => { unchanged(); fence(); unchanged() }',
     'const verify = () => { unchanged(); fence() }', unit,
     'rechecks the captured owner after the external commit fence'),
    ('recovered enabling image is not synced', proof,
     '          check()\n          fsyncSync(fd)\n          if (version(fstatSync(fd, { bigint: true })) !== before)',
     '          check()\n          if (version(fstatSync(fd, { bigint: true })) !== before)', unit,
     'requires a recovered enabling image'),
    ('path identity replaces retained descriptor', proof,
     'version(fstatSync(fd, { bigint: true }))', 'version(lstatSync(path, { bigint: true }))', unit,
     'never syncs a substitute'),
    ('corrupt registry permits clean discovery', registry,
     "    this.writeBlocked = true\n    console.error(`[registry] registry ${reason}; preserving saved state and refusing to overwrite it`)",
     "    this.writeBlocked = false\n    console.error(`[registry] registry ${reason}; preserving saved state and refusing to overwrite it`)", unit,
     'a fresh daemon never replaces truncated state'),
    ('native client drops schema three', 'src/engines/kit/nativeNotifyCursor.ts',
     "row?.schemaVersion === 3 && !Object.hasOwn(row, 'nativeAllocation') && parseNativeTurnIntent(row.nativeControl) !== null", 'false',
     'src/engines/kit/nativeNotifyCursor.spec.ts', 'keeps delivering native evidence'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(file, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', file,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


selected = set(sys.argv[2:])
if selected:
    assert selected <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
for file in dict.fromkeys(mutation[4] for mutation in mutations):
    pattern = '|'.join(row[5] for row in mutations if row[4] == file) if selected else '.'
    result = run(file, pattern)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native cancellation persistence baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == (2 if label == 'path identity replaces retained descriptor' else 1), (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run(file, pattern)
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
