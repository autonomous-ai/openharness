"""A prompt receipt reply cannot release unfinished native rearm work."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
receipt = 'src/lib/agentCreationReceipt.ts'
pending = 'src/core/agents/pendingLaunches.ts'
receipt_spec = 'src/lib/agentCreationReceipt.spec.ts'
pending_spec = 'src/core/agents/pendingLaunches.spec.ts'
mutations = [
    ('bounded reply releases unfinished work', receipt,
     'try { resolve(this.intentStatus(id, saved)) }', 'try { settle(); resolve(this.intentStatus(id, saved)) }',
     receipt_spec, 'retains actual ownership'),
    ('settlement retains preparation authority', receipt,
     '      alive = false\n      try { directory.close() }', '      try { directory.close() }',
     receipt_spec, 'releases actual preparation on held'),
    ('lost claim never releases preparation', receipt,
     '        settle()', '        if (dispatchToken) settle()',
     receipt_spec, 'releases actual preparation on lost-claim'),
    ('directory close failure skips settlement', receipt,
     '      try { directory.close() }\n      finally {', '      directory.close()\n      {',
     receipt_spec, 'subscriber retries'),
    ('settlement subscriber joins stale in-flight work', receipt,
     'clearTimeout(replyTimer); this.inFlight.delete(id)',
     'clearTimeout(replyTimer); setTimeout(() => this.inFlight.delete(id), 0)',
     receipt_spec, 'subscriber retries'),
    ('wrapper ignores expired inner preparation', pending,
     'Promise.all([authority.settled, preparationSettled]).then(() => {})', 'authority.settled',
     pending_spec, 'forwards settlement'),
    ('wrapper ignores unfinished physical effect', pending,
     'Promise.all([authority.settled, preparationSettled]).then(() => {})', 'preparationSettled',
     pending_spec, 'forwards settlement'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(spec, pattern='.'):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for spec in [receipt_spec, pending_spec]:
    result = run(spec)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Actual settlement baselines passed', flush=True)
failures = []
for label, path, before, after, spec, pattern in mutations:
    source = cli / path
    original = source.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        source.write_text(original.replace(before, after))
        result = run(spec, pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        source.write_text(original)
if failures:
    raise SystemExit('Unproven mutations: ' + ', '.join(failures))
print(f'All {len(mutations)} actual-settlement faults caught by assertions', flush=True)
