"""A cold transcript may resume without borrowing an uncertain hook's effects."""
import os
from pathlib import Path
import re
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_HOOK_MUTATIONS_OWNED') == '1'
assert Path(os.environ.get('TMUX_TMPDIR', '/missing')).is_dir()
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ('TMUX', 'TMUX_PANE') or key.startswith('RECORD_'):
        environment.pop(key)
server = cli / 'src/hookServer.ts'
spec = 'src/lib/registry.admission.spec.ts'
mutations = [
    ('transcript grants effect recovery',
     'if (durableProcesses.get(durableKey(row))?.ready) return true',
     'if (durableProcesses.get(durableKey(row))?.ready || durableProcesses.get(durableKey(row))?.transcript) return true',
     'cold uncertain prompt'),
    ('unknown first binding grants observation',
     'firstPending > 0 && deliveries.slice(0, firstPending).some(delivery => delivery.result?.accepted === true && sameBinding(delivery))',
     'firstPending >= 0', 'uncertain first binding'),
    ('unknown Stop grants observation',
     "sameBinding(delivery) && delivery.intake.payload.hookEvent === 'UserPromptSubmit'",
     'sameBinding(delivery)', 'uncertain Stop|uncertain SessionStart'),
    ('conflicting path grants observation',
     '&& (!body.transcriptPath || body.transcriptPath === row.transcriptPath)', '', 'uncertain other path'),
    ('held binding grants observation',
     '!row.identityHold && identity === paneReadIdentity(registry.byAgent(row.agentId))',
     'identity === paneReadIdentity(registry.byAgent(row.agentId))', 'uncertain binding held'),
    ('frontier append ignored', 'owner(); snapshot.verify()', 'owner()', 'grant after frontier changes'),
    ('native deadline not checked after frontier scan',
     '          owner()\n        } }', '        } }', 'full frontier verification'),
    ('final binding change ignored',
     'if (!closed && !quiescing && context.transcript === grant && grant.identity === paneReadIdentity(row)\n'
     '            && grant.identity === paneReadIdentity(registry.byAgent(row.agentId))) return true',
     'return true', 'grant after final binding changes'),
    ('observation notification disconnected',
     '        notifyTranscripts(context)\n      }', '      }', 'cold uncertain prompt|tails later native turns'),
]


def run(pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec,
                           '--maxWorkers=1', '-t', pattern], cwd=cli, env=environment,
                          capture_output=True, text=True, timeout=60)


baseline = run('|'.join(item[3] for item in mutations))
output = re.sub(r'\x1b\[[0-9;]*m', '', baseline.stdout + baseline.stderr)
assert baseline.returncode == 0 and re.search(r'\bTests\s+[1-9]\d* passed\b', output), output
print('Cold transcript observation baseline passed', flush=True)
original = server.read_text()
failures = []
for label, before, after, pattern in mutations:
    assert original.count(before) == 1, (label, original.count(before))
    try:
        server.write_text(original.replace(before, after))
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': NOT caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        server.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
