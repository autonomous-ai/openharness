"""A recap derives only the immutable answer of its original native generation."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
wire = 'src/lib/nativeRecapWire.ts'
unit = 'src/lib/nativeRecapWire.spec.ts'
link = 'src/core/recapsLink.ts'
link_test = 'src/core/recapsLink.spec.ts'
service = 'src/services/recaps.ts'
service_test = 'src/services/recaps.spec.ts'
mutations = [
    ('recap identity omits generation', wire,
     'hash([owner.agentId, owner.sessionId, owner.processKey, generationId])',
     'hash([owner.agentId, owner.sessionId, owner.processKey])', unit, 'separates identical answers'),
    ('recap identity omits original agent', wire,
     'hash([owner.agentId, owner.sessionId, owner.processKey, generationId])',
     'hash([owner.sessionId, owner.processKey, generationId])', unit, 'separates recap identity by original agentId'),
    ('recap digest omits answer bytes', wire,
     'completion.generationId, completion.responseText])', 'completion.generationId])', unit, 'binds each digest'),
    ('foreign answer digest accepted', wire,
     ' || result.sourceDigest !== nativeRecapDigest(original)', '', unit, 'holds malformed or mismatched'),
    ('foreign derivation version accepted', wire,
     '    || result.version !== NATIVE_RECAP_VERSION\n', '', unit, 'holds malformed or mismatched'),
    ('caller mutation crosses service wait', link,
     'const original = copyNativeRecapCompletion(completion)', 'const original = completion',
     link_test, 'retains the original native generation'),
    ('native service reads latest transcript', service,
     'summary: deriveTurnSummary(original.responseText)',
     "summary: deriveTurnSummary((await core.transcripts.lastTurn(original.owner.sessionId))?.assistantText ?? '')",
     service_test, 'derives only the retained native answer'),
    ('native result emits an unfenced session notice', service,
     'const original = copyNativeRecapCompletion(value)',
     "const original = copyNativeRecapCompletion(value); core.clients.turnSummary({ type: 'turn_summary', payload: {} })",
     service_test, 'derives only the retained native answer'),
    ('native request loses process wiring', 'src/services/recapsProcess.ts',
     'await recaps.port.nativeCompletion(payload.completion as NativeRecapCompletion)',
     'undefined', 'src/services/recapsProcess.spec.ts', 'derives an old native answer'),
    ('missing service falsely claims ready', 'src/core/api.ts',
     "nativeCompletion: later({ state: 'held', reason: 'Waiting for the recaps service.' })",
     "nativeCompletion: later({ state: 'ready', reason: 'Waiting for the recaps service.' })",
     'src/core/api.spec.ts', 'tells the recaps nothing'),
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


for file in dict.fromkeys(mutation[4] for mutation in mutations):
    result = run(file)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native recap baselines passed', flush=True)
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
