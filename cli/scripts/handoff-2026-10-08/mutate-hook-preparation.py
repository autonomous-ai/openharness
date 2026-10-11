"""Break durable hook wiring in an explicitly owned disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_HOOK_MUTATIONS_OWNED') == '1'
golden = 'src/engines/nativeVersion.golden.spec.ts'
hooks = 'src/engines/nativeHooks.ts'
files = 'src/engines/kit/nativeHookFiles.ts'
attempts = 'src/engines/kit/nativeHookAttempts.spec.ts'
preparation = 'src/engines/nativeHookPreparation.spec.ts'
mutations = [
    ('wrong plugin port', hooks, 'port: String(port)', "port: '19475'", golden, ''),
    ('core installer disconnected', 'src/core/engines/hooks.ts', 'return await (snapshot ? nativeHooks.installOpencodePlugin(port, snapshot) : nativeHooks.installOpencodePlugin(port)) !== false', 'return true', golden, ''),
    ('upgrade removal disconnected', hooks, 'const removedOrInstalled = await legacy.commit(attempt)', 'const removedOrInstalled = { verify: () => {} }', golden, ''),
    ('disk confirmation bypassed', files, 'fsync(fd, settled)', 'queueMicrotask(() => settled(null))', attempts, 'event loop available'),
    ('joining deadline ignored', files, "if (performance.now() >= deadline) throw new HookPreparationHeld('the joining preparation exceeded its deadline')", 'void deadline', attempts, 'timer phase'),
    ('joining authority ignored', files, "if (options.current?.() === false) throw new HookPreparationHeld('the joining owner changed')", 'void options', attempts, 'each joining owner'),
    ('joined proof keeps wrong route', files, 'const proof = preparationProof(files, verifyRoutes)', 'const proof = preparationProof(pending.proof!.files.map(file => file.file), verifyRoutes)', attempts, 'final launch proof'),
    ('revoked caller gets newer success', hooks, '|| options.current?.() === false || snapshot?.current() === false || current.proofs', '|| snapshot?.current() === false || current.proofs', preparation, 'revoked older caller'),
    ('reservation extends original deadline', hooks, '&& opencodeInstallation.major === major && performance.now() < deadline', '&& opencodeInstallation.major === major', preparation, 'stalling reservation reads'),
    ('late proof ignores deadline', hooks, '  if (performance.now() >= deadline) return false', '  void deadline', preparation, 'after final proof reads'),
    ('peer bytes adopted as proof', files, '    // that arrived between the last verification and its filesystem reads.\n    verify()', '    // that arrived between the last verification and its filesystem reads.\n    check()', 'src/engines/kit/nativeHookFiles.spec.ts', 'peer edit during final proof capture'),
    ('foreign command ownership broadened', 'src/engines/kit/notifyHooks.ts', r'if (/[;&|<>$`(){}*?\[\]~#]/.test(char))', 'if (/[;&|<>$`(){}]/.test(char))', preparation, 'foreign shell command'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_NATIVE_VERSION_GOLDEN', 'RECORD_OTHER_ENGINES_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(specs, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


baseline = run([golden, attempts, preparation, 'src/engines/kit/nativeHookFiles.spec.ts'])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, spec, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    expected = 2 if label == 'joining authority ignored' else 1
    assert original.count(before) == expected, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Uncaught mutations: ' + ', '.join(failures))
