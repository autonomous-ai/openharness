"""A first launch retains its original owner through preparation and Cancel."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
pending = 'src/lib/nativePendingCreation.ts'
spec = 'src/lib/registry.nativeCreation.spec.ts'
golden = 'src/lib/nativePendingCreationCompatibility.golden.spec.ts'
mutations = [
    ('cold recovery normalizes pending ownership', registry, 'if (raw.nativeRetirement || raw.nativeCreation)',
     'if (raw.nativeRetirement)', spec, 'durably reserves the original'),
    ('resolved choices can be replaced', registry, 'pending.revoked || pending.prepared || pending.placement',
     'pending.revoked || pending.placement', spec, 'fills resolved choices only once'),
    ('schema six forgets its required receipt', registry,
     '    || (row.schemaVersion === 6) !== (nativeCreation !== undefined) || nativeCreation === null',
     '    || nativeCreation === null', spec, 'rejects missing pending authority'),
    ('resolved metadata loses authority', pending, '    && pending.metadata === nativeCreationMetadata(row)',
     '', spec, 'rejects metadata pending authority'),
    ('initial fingerprint is ignored', pending, ' || value.receipt.fingerprint !== nativeCreateFingerprint(request)',
     '', spec, 'rejects fingerprint pending authority'),
    ('placement is not retained', registry, 'nativeCreation: parseNativePendingCreation({ ...pending, placement })!',
     'nativeCreation: pending', spec, 'retains the exact pane server'),
    ('uncertain reserve regenerates its original metadata', registry,
     'retained ? strictPersistedRow(retained)! : {', 'false ? strictPersistedRow(retained)! : {',
     spec, 'confirms the same uncertain reservation'),
    ('publication no longer confirms original authority after sync', registry,
     'written.confirm(() => { verifyPublished(); live() })', 'written.confirm(() => {})',
     spec, 'authority expires during directory sync'),
    ('committed readback loses the original fence', registry, '    verifyPublication()\n    fence()',
     '    verifyPublication()', spec, 'after its final committed readback'),
    ('final external fence may replace the committed owner', registry,
     '    if (this.writeBlocked || this.unconfirmedBinding?.affected.has(candidate.agentId) || !latest\n'
     '      || nativeTurnTarget(latest) !== target || rowFingerprint(latest.nativeControl) !== control)',
     '    if (false)', spec, 'exact committed owner after the final external fence'),
    ('placement callback can change before use', registry,
     '() => { verify(); current() })', '() => { proof.verify(); proof.current() })',
     spec, 'original placement callbacks'),
    ('archive discards pending allocation ownership', 'src/lib/stoppedAgents.ts',
     "    if (session.nativeCreation) throw Error('The pending native creation must be accounted for before archiving.')",
     '', spec, 'refuses pending creation archives'),
    ('former ownership no longer pins admitted allocations', 'src/lib/nativeTurnIntent.ts',
     "  if (row.nativeAllocation) identity.push(['native-allocation', creationFingerprint(row.nativeAllocation)])",
     '', golden, 'retains former admitted first launches'),
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
    raise SystemExit('Healthy pending-creation baselines failed; no mutations ran.\n' + baseline.stdout + baseline.stderr)
print('Healthy pending-creation baselines passed', flush=True)
failures = []
for label, name, before, after, test, pattern in mutations:
    source = cli / name
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run([test], pattern)
        output = result.stdout + result.stderr
        if not result.returncode or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Missing pending-creation proofs: ' + ', '.join(failures))
print(f'All {len(mutations)} pending-creation faults caught by assertions', flush=True)
