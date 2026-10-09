"""Break one Store launch contribution at a time; an assertion must reject each mutation."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
path = cli / 'src/services/storeLaunch.ts'
original = path.read_text()
mutations = [
    ('drop the account at create', 'materializeWorkspace(installed, workspace, account, engine)', 'materializeWorkspace(installed, workspace, {}, engine)'),
    ('drop the account at relaunch', 'prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey)', 'prepareHarnessLaunch(installed, workspace, engine, key, {}, sourceKey)'),
    ('drop the fork source', 'prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey)', 'prepareHarnessLaunch(installed, workspace, engine, key, account, null)'),
    ('drop package argv', 'launch: prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey)', 'launch: { ...prepareHarnessLaunch(installed, workspace, engine, key, account, sourceKey), args: [] }'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('RECORD_DSH_LAUNCH_SHAPES_GOLDEN', None)
for name, before, after in mutations[int(sys.argv[2]) if len(sys.argv) > 2 else 0:]:
    assert original.count(before) == 1, name
    path.write_text(original.replace(before, after))
    try:
        result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/dshLaunchShapes.golden.spec.ts', '--maxWorkers=1'],
                                cwd=cli, env=env, text=True, capture_output=True, timeout=90)
        output = result.stdout + result.stderr
        # A compile/import/setup failure is not proof that the golden detects broken wiring.
        if result.returncode == 0 or 'AssertionError:' not in output or 'dshLaunchShapes.golden.spec.ts:' not in output:
            print(output[-6000:])
            raise SystemExit(f'{name}: not rejected by the golden assertion')
        print(f'{name}: caught by unchanged golden', flush=True)
    finally:
        path.write_text(original)
