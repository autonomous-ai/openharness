"""Check Kilo's shared adoption wiring and independent runtime entry; restore each mutation."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/otherAdoption.golden.spec.ts'
index = 'src/lib/sessionSearch/externals/index.ts'
mutations = [
    ('Kilo reads OpenCode store', index,
     "code.opencodeProvider({ engine: 'kilo', dbPath: paths.kiloDb })",
     "code.opencodeProvider({ engine: 'kilo', dbPath: paths.opencodeDb })", golden),
    ('Kilo claims OpenCode owners', index,
     "code.opencodeProvider({ engine: 'kilo', dbPath: paths.kiloDb })",
     "code.opencodeProvider({ engine: 'opencode', dbPath: paths.kiloDb })", golden),
    ('Kilo runtime depends on adoption again', 'src/engines/kilo/inProcess.ts',
     "export { KiloReader, readKiloMessages } from './reader.js'",
     "export { KiloReader, readKiloMessages } from './reader.js'\nexport { opencodeProvider } from '../../lib/sessionSearch/externals/opencode.js'",
     'src/engines/inProcess.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
command = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']
baseline = subprocess.run([*command, *sorted({item[4] for item in mutations})], cwd=cli, env=env,
                          capture_output=True, text=True, timeout=90)
if baseline.returncode:
    sys.exit('Baseline did not pass; no mutations run.\n' + baseline.stdout[-5000:] + baseline.stderr[-5000:])
for name, path, old, new, spec in mutations:
    target = cli / path
    source = target.read_text()
    assert source.count(old) == 1, (name, source.count(old))
    try:
        target.write_text(source.replace(old, new))
        result = subprocess.run([*command, spec], cwd=cli, env=env, capture_output=True, text=True, timeout=90)
        caught = result.returncode != 0 and 'AssertionError' in result.stdout + result.stderr
        print(f'{name}: {"caught by assertion" if caught else "NOT PROVEN"}', flush=True)
        if not caught:
            sys.exit(result.stdout[-5000:] + result.stderr[-5000:])
    finally:
        target.write_text(source)
