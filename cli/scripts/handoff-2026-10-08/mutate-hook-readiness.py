#!/usr/bin/env python3
"""Check startup wiring mutations in an explicitly owned disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_HOOK_MUTATIONS_OWNED') == '1'
hooks = 'src/core/engines/hooks.ts'
golden = 'src/core/engines/hookStartup.golden.spec.ts'
ready = "  coreLink.ready()\n  console.log('[cli] ready')\n"
start = "  installedHooks = env.DISABLE_HOOK_INSTALL ? undefined\n    : installEngineHooks(hookPort, { only: env.HOOK_INSTALL_ENGINES, loginShell: loginShellEnvPromise })\n"
before_ready = ready + "  // Each launch confirms its own hooks. Startup never waits on any vendor's disk or probe.\n" + start
blocked_ready = start + "  await installedHooks?.settled\n" + ready
mutations = [
    ('wrong hook port', hooks, 'hooks.install(port, nativeOptions)', 'hooks.install(port + 1, nativeOptions)', golden, ''),
    ('omit native vendors', hooks, 'of OTHER_INSTALLERS)', 'of OTHER_INSTALLERS.slice(0, 0))', golden, ''),
    ('ignore selected vendors', hooks, 'if (options.only && !options.only.has(vendor)) return', 'if (false) return', golden, ''),
    ('retain writes after shutdown', hooks, 'close: adoptions.close', 'close: () => {}', 'src/core/engines/hooks.spec.ts', 'returns shutdown authority'),
    ('collide with startup maintenance', 'src/engines/nativeHooks.ts', 'if (previous && (previous.settling || previous.major !== undefined', 'if (previous && false && (previous.settling || previous.major !== undefined', 'src/engines/nativeHookPreparation.spec.ts', 'waits for startup maintenance'),
    ('separate aliased destinations', 'src/engines/nativeHooks.ts', 'const reservation = JSON.stringify(routes.keys)', 'const reservation = root', 'src/engines/nativeHookPreparation.spec.ts', 'through alias paths'),
    ('unbounded preparation callers', 'src/engines/nativeHooks.ts', 'if (group.users >= 16) return false', 'if (false) return false', 'src/engines/nativeHookPreparation.spec.ts', 'bounds launch callers'),
    ('discard help after a core stall', 'src/engines/nativeLaunch.ts', "env: nativeProcessEnvironment(environment), encoding: 'utf8', killSignal: 'SIGKILL', maxBuffer:", "env: nativeProcessEnvironment(environment), encoding: 'utf8', timeout: 5_000, killSignal: 'SIGKILL', maxBuffer:", 'src/engines/nativeLaunch.probe.spec.ts', 'complete permission answer'),
    ('retain inherited probe pipes', 'src/engines/nativeLaunch.ts', 'child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy()', 'void child', 'src/engines/nativeLaunch.probe.spec.ts', 'inherited output pipes'),
    ('release unsettled probe capacity', 'src/engines/nativeLaunch.ts', '// An uninterruptible child retains its slot until the actual callback.\n        answer(null)', '// Incorrectly free a slot while its child can still run.\n        probes--; answer(null)', 'src/engines/nativeLaunch.spec.ts', 'retaining its slot'),
    ('await hooks before readiness', 'src/core/main.ts', before_ready, blocked_ready, 'e2e/eagerHooks.e2e.ts', 'becomes ready and serves control'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_HOOK_STARTUP_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(specs, pattern=''):
    argv = ['node', 'node_modules/vitest/vitest.mjs', 'run']
    if any(spec.startswith('e2e/') for spec in specs):
        argv += ['--config', 'vitest.e2e.config.ts']
    argv += [*specs, '--maxWorkers=1']
    if pattern:
        argv += ['-t', pattern]
    return subprocess.run(argv, cwd=cli, env=environment, text=True, capture_output=True, timeout=120)


for specs, pattern in [(sorted({item[4] for item in mutations if not item[4].startswith('e2e/')}), ''),
                       (['e2e/eagerHooks.e2e.ts'], 'becomes ready and serves control')]:
    baseline = run(specs, pattern)
    assert baseline.returncode == 0, 'Unchanged baseline failed.\n' + baseline.stdout + baseline.stderr
print('Unchanged baseline passed', flush=True)
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
