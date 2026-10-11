"""Owned disposable worktree only: broken native-version wiring must fail assertions."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_VERSION_MUTATIONS_OWNED') == '1'
golden = 'src/engines/nativeVersion.golden.spec.ts'
probe = 'src/engines/kit/nativeVersion.spec.ts'
native = 'src/engines/kit/nativeVersion.ts'
hooks = 'src/lib/discoveryScripts.spec.ts'
create = 'src/core/agents/create.spec.ts'
mutations = [
    ('version protocol', 'src/engines/opencode/contract.ts', "args: ['--version']", "args: ['--help']", golden, ''),
    ('version parser', 'src/engines/opencode/contract.ts', r'/(\d+)\.\d+\.\d+/', r'/major=(\d+)/', golden, ''),
    ('core installer disconnected', 'src/core/engines/hooks.ts', 'return await nativeHooks.installOpencodePlugin(port) !== false', 'return true', golden, ''),
    ('production resolver blocks', 'src/engines/launchControl.ts', 'await opencodeBinAsync()', 'opencodeBin()', probe, 'production resolver'),
    ('execution selects another command', native, 'execFile(file, [...rule.args]', 'execFile(binary(), [...rule.args]', probe, 'selected for this probe once'),
    ('replacement fence removed', native, 'const current = identity === probe.identity()', 'const current = true', probe, 'executable is replaced'),
    ('output bound removed', native, 'maxBuffer: 64 * 1024', 'maxBuffer: 256 * 1024', probe, 'output flood'),
    ('stdin never closes', native, 'child.stdin?.end()', "child.stdin?.write('')", probe, 'read to EOF'),
    ('memo publication ownership lost', native, 'if (attempts.get(identity) !== ticket)', 'if (false)', probe, 'older failed probe'),
    ('confirmed observation becomes unavailable', native, 'return current ? major : null', 'return current ? memo.get(identity) ?? null : null', probe, 'newer probe of the unchanged file'),
    ('obsolete installation writes', 'src/engines/nativeHooks.ts', 'if (installation !== opencodeInstallation) return false', 'void installation', hooks, 'obsolete version probe'),
    ('healthy overlapping create refused', 'src/engines/nativeHooks.ts', 'while (current !== opencodeInstallation) {', 'while (current !== opencodeInstallation) { return false;', create, 'concurrent healthy OpenCode'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_NATIVE_VERSION_GOLDEN', 'RECORD_OPENCODE_LAUNCH_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(files, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *files, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


baseline = run([golden, probe, hooks, create])
assert baseline.returncode == 0, 'Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, spec, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
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
