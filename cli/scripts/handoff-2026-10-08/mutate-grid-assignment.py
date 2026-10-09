"""Break real L2 contributions; the unchanged former-code golden must reject each by assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
mutations = [
    ('endpoint marker', 'src/lib/gridAssignmentWire.ts', "claude: 'ANTHROPIC_BASE_URL'", "claude: 'ANTHROPIC_HOST'"),
    ('model marker', 'src/lib/gridAssignmentWire.ts', "claude: 'ANTHROPIC_MODEL'", "claude: 'ANTHROPIC_OTHER_MODEL'"),
    ('process argv at models boundary', 'src/services/modelsAssignments.ts', 'return gridAssignments(processes)', "return gridAssignments(processes.map(p => ({ ...p, args: '' })))"),
    ('Pi config', 'src/lib/gridAssignment.ts', "join(dir, 'models.json')", "join(dir, 'not-models.json')"),
    ('OpenCode router', 'src/lib/gridAssignment.ts', 'return { baseUrl, model: model.toLowerCase() === GRID_ROUTER_MODEL.toLowerCase() ? null : model }', 'return { baseUrl, model }'),
    ('API endpoint form', 'src/lib/gridAssignment.ts', '[relayBaseUrl(baseUrl), anthropicBaseUrl(baseUrl)]', '[relayBaseUrl(baseUrl)]'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('RECORD_GRID_ASSIGNMENT_GOLDEN', None)
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
for name, file, before, after in mutations:
    path = cli / file
    original = path.read_text()
    assert original.count(before) == 1, name
    path.write_text(original.replace(before, after))
    try:
        result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/lib/gridAssignmentShapes.golden.spec.ts', '--maxWorkers=1'],
                                cwd=cli, env=env, text=True, capture_output=True, timeout=90)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError:' not in output or 'gridAssignmentShapes.golden.spec.ts:' not in output:
            print(output[-6000:])
            raise SystemExit(f'{name}: not rejected by the golden assertion')
        print(f'{name}: caught by unchanged golden', flush=True)
    finally:
        path.write_text(original)
