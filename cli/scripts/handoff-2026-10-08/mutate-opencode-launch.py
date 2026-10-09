"""Break OpenCode native declarations and real launch wiring; only assertion failures count."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/opencodeLaunch.golden.spec.ts'
architecture = 'src/architecture.spec.ts'
eager = 'src/core/agents/retarget.spec.ts'
mutations = [
    ('wrong native generation', 'src/engines/opencode/contract.ts', 'const OPENCODE_V2_MAJOR = 2', 'const OPENCODE_V2_MAJOR = 3', golden),
    ('version protocol', 'src/engines/opencode/contract.ts', "args: ['--version']", "args: ['--help']", golden),
    ('version parsing', 'src/engines/opencode/contract.ts', r'/(\d+)\.\d+\.\d+/', r'/major=(\d+)/', golden),
    ('native SQL session field', 'src/engines/opencode/contract.ts', "'$.model.providerID'", "'$.model.provider'", golden),
    ('native transaction absent', 'src/engines/opencode/contract.ts', "'BEGIN IMMEDIATE;'", "'-- no transaction'", golden),
    ('native API provider field', 'src/engines/opencode/contract.ts', "provider: 'providerID'", "provider: 'provider'", golden),
    ('variant lost', 'src/engines/opencode/contract.ts', "variantSeparator: '#'", "variantSeparator: '@'", golden),
    ('create version disconnected', 'src/core/agents/create.ts', 'opencode.opencodeMajorVersion()', 'null', golden),
    ('fork version disconnected', 'src/core/agents/fork.ts', 'opencode.opencodeMajorVersion()', 'null', golden),
    ('retarget native model skipped', 'src/core/agents/retarget.ts', 'if (rewritesOpencodeSession && opencode)', 'if (false)', golden),
    ('relaunch depends on optional code', 'src/core/agents/launch.ts', "import { prepareResume, repairedItemsName }", "import { loadEngine } from '../../engines/inProcess.js'\nimport { prepareResume, repairedItemsName }", architecture),
    ('composition reads optional code', 'src/core/main.ts', "opencodeMajor: engine === 'opencode' ? opencodeMajorVersion() : null", "opencodeMajor: engine === 'opencode' ? engineNow('opencode', 'an OpenCode launch was built')?.opencodeMajorVersion() ?? null : null", architecture),
    ('retarget waits on optional reader', 'src/core/agents/retarget.ts', "const opencode = session.engine === 'opencode' ? opencodeLaunch : null", "const opencode = session.engine === 'opencode' ? await (await import('../../engines/inProcess.js')).loadEngine('opencode') : null", eager),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for name in ['TMUX', 'TMUX_PANE', 'RECORD_OPENCODE_LAUNCH_GOLDEN']:
    env.pop(name, None)


def run(specs):
    pattern = ['--testNamePattern=while its optional reader is'] if specs == [eager] else []
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, *pattern, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run([golden, architecture, eager])
if baseline.returncode:
    print(baseline.stdout + baseline.stderr)
    raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, spec in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        mutated = original.replace(before, after)
        if label == 'composition reads optional code':
            old_import = 'import { inProcessScreen, preloadEngine }'
            assert mutated.count(old_import) == 1
            mutated = mutated.replace(old_import, 'import { engineNow, inProcessScreen, preloadEngine }')
        path.write_text(mutated)
        result = run([spec])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            print(output)
            raise SystemExit(f'{label}: not caught by an assertion')
        print(f'{label}: caught by assertion', flush=True)
    finally:
        path.write_text(original)
