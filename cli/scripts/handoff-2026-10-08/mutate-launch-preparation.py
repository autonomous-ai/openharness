"""Break preparation wiring or authority; only an assertion failure counts as a kill."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/dshLaunchShapes.golden.spec.ts'
launch = 'src/core/agents/launch.spec.ts'
overrides = 'src/lib/launchOverrides.spec.ts'
authority = 'src/core/agents/launchAuthority.spec.ts'
restore = 'src/core/agents/restoreLaunch.spec.ts'
mutations = [
    ('drop harness account', 'src/services/storeLaunch.ts', 'prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey)', 'prepareHarnessLaunch(installed, workspace, engine, key, {}, sourceKey)', golden),
    ('drop harness argv', 'src/lib/launchOverrides.ts', '...overrides.extraArgs, ...dsh.args', '...overrides.extraArgs, ...[]', golden),
    ('write before Store answers', 'src/lib/launchOverrides.ts', "  let dsh: Extract<DshLaunchAnswer", "  await base.commit()\n  let dsh: Extract<DshLaunchAnswer", overrides),
    ('write notes during outage', 'src/core/agents/launch.ts', "if (!result.ok && (result.unavailable || result.error === 'AGENT_CHANGED')) return result", "if (!result.ok && result.error === 'AGENT_CHANGED') return result", launch),
    ('ignore dispatch authority', 'src/core/agents/launch.ts', 'const dispatchCurrent = authority(session.agentId)', 'const dispatchCurrent = () => true', launch),
    ('ignore caller authority', 'src/core/agents/launch.ts', 'operationCurrent() && dispatchCurrent()', 'dispatchCurrent()', launch),
    ('ignore Stop revision', 'src/core/agents/launchAuthority.ts', 'deps.revision(id) === revision', 'true', authority),
    ('compare projection to live row', 'src/core/agents/launch.ts', 'session = structuredClone(session)', "session = structuredClone(session)\n    if (session.engine === 'terminal') return { ok: false, error: 'AGENT_CHANGED', detail: 'wrong projection fence' }", restore),
    ('fail cancelled restore', 'src/core/agents/restoreLaunch.ts', "if (!built.ok && built.error === 'AGENT_CHANGED') return { cancelled: true }", '// cancellation incorrectly becomes a launch error', restore),
    ('reuse committed preparation', 'src/lib/launchOverrides.ts', 'if (committed) return', 'if (false) return', overrides),
    ('restore old write order without duplicate writes', 'src/lib/launchOverrides.ts',
     'const base = await prepareBaseLaunchOverrides({ ...deps, machine: () => machine }, engine, source, configKey)',
     'const originalBase = await prepareBaseLaunchOverrides({ ...deps, machine: () => machine }, engine, source, configKey)\n'
     '  const early = originalBase.ok ? await originalBase.commit() : originalBase\n'
     '  const base = early.ok ? { ok: true as const, commit: async () => early } : early',
     'src/engines/launchArgv.golden.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in ['TMUX', 'TMUX_PANE', 'RECORD_DSH_LAUNCH_SHAPES_GOLDEN']:
    env.pop(key, None)

def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)

baseline = run(list(dict.fromkeys(item[4] for item in mutations)))
if baseline.returncode:
    print(baseline.stdout + baseline.stderr)
    raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, spec in mutations[int(os.environ.get('MUTATION_START', '0')):]:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            print(output)
            raise SystemExit(f'{label}: not caught by an assertion')
        print(f'{label}: caught by assertion', flush=True)
    finally:
        path.write_text(original)
