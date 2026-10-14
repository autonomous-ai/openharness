"""A disconnected staging ownership/lifetime guard must fail an assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
staging = 'src/engines/kit/nativeHookStaging.ts'
files = 'src/engines/kit/nativeHookFiles.ts'
mutations = [
    ('final acquisition deadline removed', staging,
     "if (expired || acquiring && performance.now() >= deadline) held('acquisition exceeded its deadline')",
     '', 'final namespace inspection crosses deadline'),
    ('delivery failure loses cleanup owner', staging,
     'leases.add(tracked)\n          try { if (!ownerCurrent())',
     'try { if (!ownerCurrent())', 'delivery guard throws'),
    ('extra writer lane', staging, 'const LANES = 8,', 'const LANES = 9,', 'holds the ninth writer'),
    ('unknown owner treated as dead', staging, 'writer = structuredClone(writer)',
     'writer = structuredClone(writer); dead = async () => true', 'holds the ninth writer'),
    ('retained metadata bytes unchecked', staging, ' || readlinkSync(file) !== text', '',
     'retained authority bytes'),
    ('iterator acquisition route unchecked', staging, 'verifyOpenedRoute(); verify()', 'verify()',
     'iterator redirected through an ancestor'),
    ('cleanup permits recreated file', staging,
     "try { lstatSync(path); held('stage was recreated during cleanup') } catch (error) { if (!missing(error)) throw error }", '',
     'does not release a stage recreated'),
    ('dead predecessor absence unchecked', staging,
     "try { lstatSync(path); held('predecessor stage was recreated during cleanup') } catch (error) { if (!missing(error)) throw error }", '',
     'does not retire a dead predecessor'),
    ('new stages ignore request revocation', staging, 'const allowed = !closed && current()',
     'const allowed = !closed', 'revokes new effects|final namespace inspection crosses revocation'),
    ('exclusive right recorded after fallible proof', staging,
     'created?.({ file, text, verify: () => proof().verify() })',
     'proof(); created?.({ file, text, verify: () => proof().verify() })',
     'remembers exclusive .* ownership'),
    ('actual disk confirmations use every worker', files,
     'Math.min(2, (Number.isFinite(configuredThreads) ? configuredThreads : 1) - 1)', '8',
     'shares the actual disk limiter'),
    ('stage names reused', staging, '${++sequence}.tmp', '${1}.tmp', 'serializes sequential stages'),
    ('initializer gap accepted', staging, 'if (!saved) { gap = true; continue }', 'if (!saved) break',
     'holds missing initializer history'),
    ('authority rebind adopts replacement', staging, 'for (const prior of originalAuthority) prior.verify()', '',
     'does not adopt coherently replaced authority'),
    ('cleanup route unchecked before unlink', files, 'stage?.verifyCleanup()', '',
     'cleanup authority before unlinking'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run',
                           'src/engines/kit/nativeHookStaging.spec.ts', '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


baseline = run()
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Staging baseline passed', flush=True)
failed = []
for label, relative, before, after, pattern in mutations:
    source = cli / relative
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
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
