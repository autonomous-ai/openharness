#!/usr/bin/env python3
"""Break native launch boundaries in an explicitly owned disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_NATIVE_MUTATIONS_OWNED') == '1'
launch = 'src/engines/nativeLaunchCompatibility.golden.spec.ts'
grid = 'src/lib/gridConfigCompatibility.golden.spec.ts'
guard = 'src/engines/kit/nativeLaunchGuard.spec.ts'
prepare = 'src/engines/prepareNativeLaunch.spec.ts'
settings = 'src/engines/kit/hookSettings.spec.ts'
mutations = [
    ('ignore captured executable', 'src/lib/engineLaunch.ts', 'opts.native?.executable?.command ?? engineBin(engine)', 'engineBin(engine)', launch, ''),
    ('drop original first prompt', 'src/lib/engineLaunch.ts', 'if (opts.firstPrompt) argv.push(...firstPromptArgs(engine, opts.firstPrompt))', 'if (false) argv.push(...firstPromptArgs(engine, opts.firstPrompt!))', launch, ''),
    ('disconnect installer dispatch', 'src/engines/kit/nativeInstall.ts', '      dispatch(runtime, file, hash)', '      void runtime; void file; void hash', launch, ''),
    ('accept unfinished visible executable', 'src/engines/prepareNativeLaunch.ts', 'obligation && !obligation.complete ? held(obligation.detail) : found', 'false ? held(obligation!.detail) : found', prepare, 'newly visible executable'),
    ('skip fresh post-install observation', 'src/engines/prepareNativeLaunch.ts', 'const prepared = await inspect(engine, source)', 'const prepared = found', prepare, 'fresh post-install snapshot'),
    ('drop final hook proof', 'src/engines/kit/nativeLaunchGuard.ts', 'files: launch.proofs.flatMap(item => item.files)', 'files: []', guard, 'changed hook contents'),
    ('ignore prepared executable identity', 'src/engines/kit/nativeLaunchGuard.ts', '!==p.identity)throw 0;', '===undefined)throw 0;', guard, 'after shell startup'),
    ('change published configuration', 'src/lib/publishedGridConfig.ts', 'await previous.replace(file.content, attempt, previous.content === null)', "await previous.replace(file.content + '\\n', attempt, previous.content === null)", grid, ''),
    ('drop Messages within the shared hook reservation', 'src/engines/kit/hookSettings.ts', 'if (settings.inbox) await installMessagesBlock(settings, home, attempt, verifyRequired)', 'void verifyRequired', settings, 'publishes one current'),
    ('globally adopt a session profile', 'src/engines/nativeLaunch.ts', 'home === implicitHome', 'true', 'src/engines/nativeLaunch.spec.ts', 'profile scoped to its session'),
    ('approve first owned block only', 'src/engines/kit/hookReview.ts', 'for (const [blockIndex, block] of blocks.entries())', 'for (const [blockIndex, block] of [...blocks.entries()].slice(0, 1))', settings, 'earlier optional hook'),
    ('own marker-only foreign commands', 'src/engines/kit/messagesHook.ts', "return value === messagesCommand(root, node)", "return value === messagesCommand(root, node) || value.includes('harness-agent-messages')", 'src/engines/kit/messagesHook.spec.ts', ''),
    ('drop saved local trust authority', 'src/core/agents/launches.ts', '{ local: saved.local }', '{ local: false }', 'src/core/agents/nativeCreate.spec.ts', 'saved local authority true'),
    ('publish stale pane hold', 'src/core/agents/newPane.ts', "if (!current()) return\n        if (waiting === true)", "if (waiting === true)", 'src/core/agents/newPane.spec.ts', 'delayed native hold'),
    ('drop nested retarget native proof', 'src/core/agents/retarget.ts', 'retargetPermission.permissionMode ?? null, dispatchCurrent), isCurrent: dispatchCurrent', 'retargetPermission.permissionMode ?? null, current), isCurrent: current', 'src/core/agents/retarget.spec.ts', 'proof changes during hold-open'),
    ('drop fallback native proof', 'src/lib/restoreAgents.ts', 'const dispatchCurrent = () => current() && launch.current?.() !== false\n    return inPane', 'const dispatchCurrent = () => current()\n    return inPane', 'src/lib/restoreAgents.spec.ts', 'fallback proof expires'),
    ('drop captured native API authority', 'src/engines/kit/nativeSessionModel.ts', '{ ...deps, cwd: input.cwd, store: input.dbPath, checkCatalog: input.checkCatalog }', '{ current: deps.current, cwd: input.cwd, store: input.dbPath, checkCatalog: input.checkCatalog }', 'src/engines/kit/nativeMutationDispatch.spec.ts', 'public apply API'),
    ('inherit absent native API location', 'src/engines/kit/nativeSessionModel.ts', 'env: nativeProcessEnvironment(authority.environment)', 'env: { ...process.env, ...authority.environment }', 'src/engines/kit/nativeMutationDispatch.spec.ts', 'public apply API'),
    ('forget native receipt environment', 'src/engines/kit/nativeSessionModel.ts', ' || previous.environment !== environment', '', 'src/engines/kit/nativeMutationDispatch.spec.ts', 'newly captured store'),
    ('trust an obsolete empty read', 'src/core/agents/create.ts', '          files.verify()', '          void files', 'src/core/agents/create.spec.ts', 'changed after enumeration'),
    ('recognize an inline launch as held', 'src/lib/nativePaneHold.ts', '#{==:#{m:*${NATIVE_LAUNCH_MARKER}=*,#{pane_start_command}},0}', '1', 'src/lib/nativePaneHold.spec.ts', 'sourced false'),
    ('replace a newer pane occupant', 'src/lib/nativePaneHold.ts', '#{==:#{pane_pid},"+pid+"}', '1', 'src/lib/nativePaneHold.spec.ts', 'delayed server command'),
    ('lose legacy pane ownership', 'src/lib/nativePaneHold.ts', 'const command = `/usr/bin/env HARNESS_DAEMON=${owner} ${heldCommand}`', 'const command = heldCommand', 'src/lib/nativePaneHold.spec.ts', 'sourced true'),
    ('wait indefinitely for the tmux client', 'src/lib/nativePaneHold.ts', 'timeout:2000', 'timeout:60000', 'src/lib/nativePaneHold.spec.ts', 'stalled transition'),
    ('fail unconfirmed native launch', 'src/core/agents/newPane.ts', 'registry.setLaunch(pending.agentId, nativeToken', 'registry.setLaunch(pending.agentId, false', 'src/core/agents/newPane.spec.ts', 'post-rc native guard hold'),
    ('forget an unconfirmed native launch after crash', 'src/lib/restoreAgents.ts', 'if (nativeToken) {\n      // A core crash', 'if (false) {\n      // A core crash', 'src/lib/restoreAgents.spec.ts', 'unrecognized inert launch'),
    ('retain restore authority after shutdown', 'src/core/agents/heldLaunches.ts', 'restore(new Set([agentId]), current)', 'restore(new Set([agentId]), () => true)', 'src/lib/restoreAgents.spec.ts', 'shutdown begins during launch preparation'),
    ('forget prepared dispatch authority', 'src/core/agents/launches.ts', "if (!authority.current()) return { state: 'unconfirmed' }", 'void authority', 'src/core/agents/launches.spec.ts', 'before invocation'),
]
environment = dict(os.environ, TZ='UTC', TMPDIR='/tmp', HARNESS_CONNECTIONS_PORT='0')
for key in ('TMUX', 'TMUX_PANE', 'RECORD_NATIVE_LAUNCH_GOLDEN', 'RECORD_GRID_CONFIG_GOLDEN'):
    environment.pop(key, None)
tmux = cli.parent / '.harness/tmux'
tmux.mkdir(parents=True, exist_ok=True)
environment['TMUX_TMPDIR'] = str(tmux)


def run(specs, pattern=''):
    command = ['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1']
    if pattern:
        command += ['-t', pattern]
    return subprocess.run(command, cwd=cli, env=environment, text=True, capture_output=True, timeout=240)


baseline = run(sorted({item[4] for item in mutations}))
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
