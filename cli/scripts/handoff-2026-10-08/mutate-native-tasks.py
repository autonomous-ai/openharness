"""Task presentation must retain native scope without inventing child success."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
tasks = 'src/core/turns/nativeTasks.ts'
unit = 'src/core/turns/nativeTasks.spec.ts'
control = 'src/core/turns/nativeTurnControl.ts'
composition = 'src/core/turns/nativeTurnControl.spec.ts'
mutations = [
    ('task ID omits its native generation', tasks,
     'JSON.stringify([scope, generation.id, toolUseId])', 'JSON.stringify([scope, toolUseId])',
     unit, 'separates identical tool IDs by original generation'),
    ('task ID omits its original owner', tasks,
     'JSON.stringify([scope, generation.id, toolUseId])', 'JSON.stringify([generation.id, toolUseId])',
     unit, 'separates identical tool IDs by original'),
    ('late task revives after parent Stop', tasks,
     "state: generation.terminal || cancelled ? 'retired' : 'observed'",
     "state: cancelled ? 'retired' : 'observed'", composition, 'publishes late Task observations'),
    ('Cancel cannot retire native tasks', control,
     'nativeTasks(original, generation, generationContent.tools, cancelled)',
     'nativeTasks(original, generation, generationContent.tools, false)',
     composition, 'keeps task results unconfirmed after local Cancel'),
    ('conflicting native requests pick one input', tasks,
     'const ambiguous = names.size > 1 || inputs.size > 1', 'const ambiguous = false',
     unit, 'holds conflicting'),
    ('foreign generation observation is adopted', tasks,
     'identity(observation.owner) !== scope || observation.generationId !== generation.id',
     'identity(observation.owner) !== scope', unit, 'refuses a task detached from its original generation'),
    ('observation loses its original retained fact', tasks,
     "observation.event !== 'preToolUse' || !knownFacts.has(observation.factId)",
     "observation.event !== 'preToolUse'", unit, 'refuses a task detached from its original fact'),
    ('request fabricates child success', tasks,
     "input, result: 'unconfirmed', reason", "input, result: 'succeeded', reason",
     unit, 'observes an exact task request'),
    ('controller omits native task projection', control,
     'nativeTasks(original, generation, generationContent.tools, cancelled)',
     '{ tasks: [], held: [] }', composition, 'publishes late Task observations'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(file, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', file,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for file in [unit, composition]:
    result = run(file)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native task projection and control baselines passed', flush=True)
failures = []
for label, name, before, after, file, pattern in mutations:
    path = cli / name
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run(file, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
