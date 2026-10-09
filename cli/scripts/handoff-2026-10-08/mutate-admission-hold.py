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
     "    if (!current(key, job)) { discard(key, job); return }\n    // A newer",
     "    // A newer", 'src/core/engines/pendingAdmission.spec.ts'),
    ('malformed source admits', 'src/engines/kit/storeSource.ts',
     "return typeof source === 'string' ? source : { unavailable: true, reason: 'transient' }",
     "return typeof source === 'string' ? source : ''", 'src/engines/kit/storeSource.spec.ts'),
    ('incomplete homes admit', 'src/hookServer.ts',
     "if (home !== env.HERMES_HOME && !complete) unavailable = true",
     "if (false) unavailable = true", 'src/hookServer.hermes.spec.ts'),
    ('stop loses admission fence', 'src/hookServer.ts',
     "!isRecentlyDeleted(processAgent.agentId) && ", "", 'src/hookServer.hermes.spec.ts'),
    ('unverified child erases parent', 'src/core/engines/pendingAdmission.ts',
     "const queue = jobs.get(key) ?? []", "const queue: Job[] = []", 'src/core/engines/pendingAdmission.spec.ts'),
    ('older retry replaces accepted conversation', 'src/core/engines/pendingAdmission.ts',
     "const status = order.status(key, job.id, job.request.order)", "const status = 'current'", 'src/hookServer.hermes.spec.ts'),
    ('live backpressure writes offline', 'hook/notify.mjs',
     "if (res.statusCode === 429 || (res.statusCode === 202 && reply?.retry === true)) { resolve('held'); return }",
     "if (false) { resolve('held'); return }", 'src/hookNotify.spec.ts', ['-t', 'Hermes live admission']),
    ('held child is never revisited', 'src/core/engines/pendingAdmission.ts',
     "const peer = leaders(key, job).find(other => other !== job)", "const peer: Job | undefined = undefined", 'src/core/engines/pendingAdmission.spec.ts'),
    ('older duplicate downgrades intent', 'src/core/engines/pendingAdmission.ts',
     "if (known !== undefined && (request.order.firedAt === undefined || request.order.firedAt < known)) return true",
     "if (false) return true", 'src/core/engines/pendingAdmission.spec.ts'),
    ('stale candidate hides refreshed authority', 'src/core/engines/pendingAdmission.ts',
     "if (previous.request.current()) return true", "return true", 'src/core/engines/pendingAdmission.spec.ts'),
    ('mixed order promotes older intent', 'src/core/engines/admissionOrder.ts',
     "if (a.firedAt === undefined) return b.firedAt === undefined ? a.arrival - b.arrival : -1\n  if (b.firedAt === undefined) return 1\n  return a.firedAt - b.firedAt || a.arrival - b.arrival",
     "return a.firedAt !== undefined && b.firedAt !== undefined ? a.firedAt - b.firedAt : a.arrival - b.arrival",
     'src/core/engines/pendingAdmission.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
command = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']
baselines = [[*sorted({item[4] for item in mutations if len(item) == 5})]]
baselines.extend([item[4], *item[5]] for item in mutations if len(item) == 6)
for specs in baselines:
    baseline = subprocess.run([*command, *specs], cwd=cli, env=env, capture_output=True, text=True, timeout=90)
    if baseline.returncode:
        sys.exit('Baseline failed; no mutations run.\n' + baseline.stdout[-5000:] + baseline.stderr[-5000:])
for name, path, old, new, spec, *filters in mutations:
    target = cli / path
    source = target.read_text()
    assert source.count(old) == 1, (name, source.count(old))
    try:
        target.write_text(source.replace(old, new))
        result = subprocess.run([*command, spec, *(filters[0] if filters else [])], cwd=cli, env=env, capture_output=True, text=True, timeout=90)
        caught = result.returncode != 0 and 'AssertionError' in result.stdout + result.stderr
        print(f'{name}: {"caught by assertion" if caught else "NOT PROVEN"}', flush=True)
        if not caught:
            sys.exit(result.stdout[-5000:] + result.stderr[-5000:])
    finally:
        target.write_text(source)
