"""Original replacement recovery must fence the actual durable publication."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
reader = 'src/engines/kit/nativeRearmProof.ts'
storage_spec = 'src/lib/registry.nativeControl.spec.ts'
reader_spec = 'src/engines/kit/nativeRearmProof.spec.ts'
mutations = [
    ('display label replaces canonical route key', reader, [(
        'row.primaryRuntimeKey !== terminalRouteKey(row.runtimes[0])',
        'row.primaryRuntimeKey !== `tmux:${row.tmuxPane}`')], reader_spec, 'recovers the original live witness'),
    ('original reservation target is ignored', reader, [(
        'nativeTurnTarget(row) !== rearm.target', 'false')], reader_spec, 'refuses target drift'),
    ('proof binding is skipped', registry, [(
        'binding.target !== target || binding.controlFingerprint !== creationFingerprint(control)\n'
        "      || binding.requestFingerprint !== creationFingerprint({ fingerprint, request })) {\n      throw new IdentityReadUnavailable('the native proof belongs to a different replacement reservation')",
        "false) {\n      throw new IdentityReadUnavailable('the native proof belongs to a different replacement reservation')")], storage_spec, 'requires the proof to retain'),
    ('staging can outlive the final fence', registry, [(
        'atomicWriteJson(FILE, serialized, false, bindingCommit?.verify, bindingCommit?.confirm)',
        'atomicWriteJson(FILE, serialized, false, undefined, bindingCommit?.confirm)')], storage_spec, 'revoked during staging'),
    ('memory admission precedes final confirmation', registry, [(
        'atomicWriteJson(FILE, serialized, false, bindingCommit?.verify, bindingCommit?.confirm)',
        'atomicWriteJson(FILE, serialized, false, bindingCommit?.verify)')], storage_spec, 'revoked during confirmation'),
    ('post-rename receipt revocation is ignored', registry, [(
        'source.verifyDirectory(); verifyExecution(); current()',
        'source.verifyDirectory(); current()')], storage_spec, 'revoked during receipt'),
    ('a substituted inode can confirm equal bytes', registry, [(
        "if (version(lstatSync(file, { bigint: true })) !== published)", 'if (false)')], storage_spec, 'revoked during substitute'),
    ('in-place post-rename changes become the intended image', registry, [(
        "if (written.content !== contents) throw new IdentityReadUnavailable('the published replacement bytes changed')",
        "if (false) throw new IdentityReadUnavailable('the published replacement bytes changed')")], storage_spec, 'rewritten bytes in the actual writer inode'),
    ('retry forgets the original published inode', registry, [(
        'verifyDirectory(); replacement.verifyPublished!(); retained.verify()',
        'verifyDirectory(); retained.verify()')], storage_spec, 'uncertain recovery on equal-bytes'),
    ('uncertain replacement is not recoverable from its original source', registry, [(
        'if (!pending?.affected.has(original.agentId))', 'if (true)')], storage_spec, 'reproves the original real receipt'),
    ('retry retains a growing recursive route proof', registry, [(
        'const verifyDirectory = replacement.verifyDirectory',
        'const verifyDirectory = () => { replacement.verifyDirectory(); retained.verifyDirectory() }')],
        storage_spec, 'keeps retry proof work constant'),
    ('post-rename close can mask its uncertain publication', registry, [(
        'const closeFile = () => { const opened = fd; fd = undefined; if (opened !== undefined) closeSync(opened) }',
        'const closeFile = () => { if (fd !== undefined) closeSync(fd); fd = undefined }'), (
        "try { closeFile() } catch { /* preserve the operation's original failure */ }", 'closeFile()')],
        storage_spec, 'closing the renamed writer reports failure'),
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


baseline = run([storage_spec, reader_spec])
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native replacement commit baseline passed', flush=True)
failures = []
for label, path, replacements, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    try:
        changed = original
        for before, after in replacements:
            assert changed.count(before) == 1, (label, changed.count(before))
            changed = changed.replace(before, after)
        source.write_text(changed)
        result = run([spec], pattern)
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
print(f'All {len(mutations)} replacement publication faults caught by assertions', flush=True)
