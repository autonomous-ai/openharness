"""Catalog, terminal reserve and actual I/O guards must fail assertions."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
staging = 'src/engines/kit/nativeHookStaging.ts'
files = 'src/engines/kit/nativeHookFiles.ts'
catalog = 'src/engines/kit/nativeHookCatalog.ts'
read_fence = 'src/engines/kit/nativeHookReadFence.ts'
mutations = [
    ('catalog publication guard disconnected', catalog,
     'metadata.publish(file, text, verify, exclusive, created, admitPublication)',
     'metadata.publish(file, text, verify, exclusive, created)', 'last flat leaf check', 1),
    ('observed seal treated as confirmed', catalog, 'if (authorized) {',
     'if (prior) {', 'successful immutable seal', 1),
    ('post-proof owner checks removed', read_fence,
     'for (const check of finalChecks) synchronously(check)\n        if (after) synchronously(after)',
     '', 'checks nested owners', 1),
    ('published identity discarded', catalog, 'publishedOutside.verify(); outside?.verify()',
     'outside?.verify()', 'first-version publication', 1),
    ('initial catalog absence forgotten', catalog,
     'return confirm(versionFile, versionText, () => { check(); verifyEmpty() })',
     'return confirm(versionFile, versionText, () => { check() })', 'retains initial catalog absence', 1),
    ('initial journal emptiness forgotten', catalog, 'proof.verify(); verifyEmpty() }, baseVerify)',
     'proof.verify() }, baseVerify)', 'retains the empty journal frontier', 1),
    ('fixed-name ancestor fences removed', catalog, 'metadata.routeStamps(canonical)',
     '(() => {})', 'discards an ancestor redirection', 4),
    ('existing key beyond a hole ignored', catalog,
     'before.allocations.find(item => item.kind === kind && item.key === hashed)',
     'before.allocations.find(() => false)', 'finds an existing key beyond', 1),
    ('terminal reserve consumed by intake', staging, 'const normalGenerations = maxGenerations - terminalGenerations',
     'const normalGenerations = maxGenerations', 'holds new intake at normal exhaustion', 1),
    ('terminal fallback disconnected', staging,
     "if (!terminal && purpose === 'terminal' && terminalGenerations) return acquire(current, purpose, true)",
     '', 'holds new intake at normal exhaustion', 1),
    ('prefix cutover not durable', staging,
     'await syncDirectory(space.witnesses, verify)\n      await syncParents(space.directory, verify)',
     '', 'confirms every exhausted prefix', 1),
    ('stage-free actual I/O tracking removed', files,
     'options.track?.(', 'void (', 'keeps stage-free confirmation I/O alive', 2),
]

environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                           'src/engines/kit/nativeHookCatalog.spec.ts',
                           'src/engines/kit/nativeHookReadFence.spec.ts',
                           'src/engines/kit/nativeHookStaging.spec.ts', '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=180)


baseline = run('|'.join(dict.fromkeys(row[4] for row in mutations)))
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Catalog/reserve baseline passed', flush=True)
failed = []
for label, relative, before, after, pattern, count in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == count, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failed.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failed:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failed))
