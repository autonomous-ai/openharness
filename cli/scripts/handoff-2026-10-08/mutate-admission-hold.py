"""Break admission evidence and publication guards; only assertion failures count as proof."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/otherAdmission.golden.spec.ts'
mutations = [
    ('failed store read admits', 'src/engines/kit/storeSource.ts',
     "if (!result.ok) return { unavailable: true, reason: result.reason }", "if (!result.ok) return ''", golden),
    ('absent source row admits', 'src/hookServer.ts',
     "if (answer === null) continue", "if (answer === null) return { kind: 'accept', value: undefined }", golden),
    ('late source reply publishes', 'src/core/engines/pendingAdmission.ts',
     "    if (!current(key, job)) { discard(key, job); return }\n    if (decision.kind",
     "    if (decision.kind", 'src/core/engines/pendingAdmission.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
command = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']
baseline = subprocess.run([*command, *sorted({item[4] for item in mutations})], cwd=cli, env=env,
                          capture_output=True, text=True, timeout=90)
if baseline.returncode:
    sys.exit('Baseline failed; no mutations run.\n' + baseline.stdout[-5000:] + baseline.stderr[-5000:])
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
