"""Allocation references must survive Cancel/recovery and block unsafe effects."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
allocation = 'src/lib/nativeAllocation.ts'
registry = 'src/lib/registry.ts'
saved = 'src/lib/stoppedAgents.ts'
unit = 'src/lib/nativeAllocation.spec.ts'
live_spec = 'src/lib/registry.nativeControl.spec.ts'
saved_spec = 'src/lib/stoppedAgents.nativeControl.spec.ts'
controller = 'src/core/agents/nativeRearm.spec.ts'
mutations = [
    ('admission discards earlier allocations', allocation, '[...(saved?.receipts ?? []), next]', '[next]',
     live_spec, 'retains all prior allocations'),
    ('reference ignores semantic fingerprint', allocation, 'if (fingerprint !== value.fingerprint) return null', 'if (false) return null',
     unit, 'unsupported reference'),
    ('same-ID conflict becomes retry', allocation, 'creationFingerprint(existing) === creationFingerprint(next) ? saved! : held()', 'saved!',
     unit, 'refuses same-ID conflicts'),
    ('full history permits another launch', allocation, 'saved.receipts.length < NATIVE_ALLOCATION_LIMIT', 'true',
     controller, 'holds full'),
    ('earlier pane token can be reused', allocation, ' || value.request.launchToken === launchToken', '',
     controller, 'reuses an earlier pane token'),
    ('reservation ignores earlier pane token', 'src/lib/nativeTurnIntent.ts',
     'nativeAllocationCanReserve(row.nativeAllocation, proposed.requestId, proposed.launchToken)',
     'nativeAllocationCanReserve(row.nativeAllocation, proposed.requestId)', live_spec, 'reuses a retained pane token'),
    ('loaded row loses allocation', registry, '          ...(raw.nativeAllocation ? { nativeAllocation: parseNativeAllocation(raw.nativeAllocation)! } : {}),', '',
     live_spec, 'through Cancel, registration and a cold reload'),
    ('registration loses allocation', registry, '      ...(existing?.nativeAllocation ? { nativeAllocation: existing.nativeAllocation } : {}),', '',
     live_spec, 'through Cancel, registration and a cold reload'),
    ('ordinary flush erases allocation', registry, "throw new IdentityReadUnavailable('the original native allocations changed outside proven admission or retirement')", 'continue',
     live_spec, 'ordinary flush cannot drop'),
    ('target ignores allocation', 'src/lib/nativeTurnIntent.ts', "  if (row.nativeAllocation) identity.push(['native-allocation', creationFingerprint(row.nativeAllocation)])", '',
     live_spec, 'invalidates retained live evidence'),
    ('live admission omits allocation', registry,
     'schemaVersion: 4, nativeControl: next, nativeAllocation,\n      processIdentity', 'schemaVersion: 3, nativeControl: next,\n      processIdentity',
     live_spec, 'through Cancel, registration and a cold reload'),
    ('saved admission omits allocation', registry,
     'schemaVersion: 4, nativeControl: next, nativeAllocation, processIdentity', 'schemaVersion: 3, nativeControl: next, processIdentity',
     'src/lib/nativeArchiveReturn.spec.ts', 'saved Resume at initial publication'),
    ('generic live control admits replacement', registry,
     'if (next.rearm?.replacement && rowFingerprint(next.rearm.replacement) !== rowFingerprint(original.nativeControl?.rearm?.replacement))', 'if (false)',
     live_spec, 'generic control cannot admit'),
    ('generic saved control admits replacement', saved,
     'if (next.rearm?.replacement && creationFingerprint(next.rearm.replacement)\n      !== creationFingerprint(original.nativeControl?.rearm?.replacement ?? null))', 'if (false)',
     saved_spec, 'generic saved control cannot introduce'),
    ('saved snapshot erases allocation', saved,
     'if (creationFingerprint(previous?.nativeAllocation ?? null) !== creationFingerprint(session.nativeAllocation ?? null))', 'if (false)',
     saved_spec, 'ordinary saved drop'),
    ('recovery forgets committed allocation', 'src/core/agents/nativeRearmRecovery.ts',
     '          schemaVersion: 4, nativeAllocation: appendNativeAllocation(original.nativeAllocation, receipt),', '',
     live_spec, 'confirms live recovery on its first call'),
    ('new schema normalized to missing authority', registry,
     '    || (row.schemaVersion === 4 || row.schemaVersion === 5) !== (nativeAllocation !== undefined) || nativeAllocation === null', '    || nativeAllocation === null',
     live_spec, 'saved allocation has missing corruption'),
    ('old schema accepts allocation authority', registry,
     '    || (row.schemaVersion === 4 || row.schemaVersion === 5) !== (nativeAllocation !== undefined) || nativeAllocation === null', '    || nativeAllocation === null',
     live_spec, 'saved allocation has schema3 corruption'),
    ('bundled reader forgets schema four', 'src/engines/kit/nativeNotifyCursor.ts', "row?.schemaVersion === 4 && parseNativeTurnIntent(row.nativeControl) !== null", 'false',
     'src/engines/kit/nativeNotifyCursor.spec.ts', 'keeps delivering native evidence'),
    ('writer cannot read retained allocation row', 'src/engines/kit/nativeRearmWitness.ts',
     '![3, 4].includes(selected[0].schemaVersion as number)', 'selected[0].schemaVersion !== 3',
     'src/engines/kit/nativeRearmWitness.spec.ts', 'permanent allocation history'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR required'


def run(files, pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=120)


selected = set(sys.argv[2:])
if selected:
    assert selected <= {row[0] for row in mutations}, 'Unknown mutation label'
    mutations = [row for row in mutations if row[0] in selected]
baseline = run(list(dict.fromkeys(row[4] for row in mutations)), '|'.join(dict.fromkeys(row[5] for row in mutations)))
if baseline.returncode:
    raise SystemExit('Healthy allocation baselines failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Healthy native allocation wiring cases passed', flush=True)
failures = []
for label, name, before, after, spec, pattern in mutations:
    source = cli / name
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if not result.returncode or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Unproved allocation faults: ' + ', '.join(failures))
print(f'All {len(mutations)} native allocation faults caught by assertions', flush=True)
