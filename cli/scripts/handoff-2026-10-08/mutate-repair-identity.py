"""Break native identity declarations/control wiring. Only assertion failures count."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/repairIdentity.golden.spec.ts'
eager = 'src/lib/sessionRepair.eager.spec.ts'
bounded = 'src/engines/kit/sessionIdentity.spec.ts'
bind = 'src/core/agents/bind.spec.ts'
stop = 'src/lib/stopAgentService.spec.ts'
saved = 'src/lib/stoppedAgents.spec.ts'
mutations = [
    ('Muse workspace field', 'src/engines/muse/contract.ts', "'workspace_root'", "'missing_workspace'", golden),
    ('Muse task mistaken for run', 'src/engines/muse/contract.ts', "value: 'run'", "value: 'task'", golden),
    ('Muse run start lost', 'src/engines/muse/contract.ts', "value: 'started'", "value: 'stopped'", golden),
    ('Pi header type', 'src/engines/pi/contract.ts', "type: 'session'", "type: 'message'", golden),
    ('Pi folder prefix', 'src/engines/pi/contract.ts', "prefix: '--'", "prefix: 'wrong-'", golden),
    ('Pi file path mistaken for id', 'src/engines/pi/contract.ts', r'(?!.*\.jsonl$)', '', golden),
    ('Pi header cwd', 'src/engines/pi/contract.ts', "cwd: ['cwd']", "cwd: ['other']", golden),
    ('Pi partial entry accepted', 'src/engines/kit/sessionIdentity.ts', "head.split('\\n').slice(0, -1)", "head.split('\\n')", golden),
    ('Pi wrong first entry ignored', 'src/engines/kit/sessionIdentity.ts', "if (valueAt(record, ['type']) !== rule.type) return null", "if (valueAt(record, ['type']) !== rule.type) continue", golden),
    ('Pi duplicate chosen', 'src/lib/sessionRepair.ts', 'if (matches.length > 1)', 'if (false)', golden),
    ('Pi core header disconnected', 'src/lib/sessionRepair.ts', 'const head = await readPiHead(join(directory, file))', 'const head = null', golden),
    ('Muse core identity disconnected', 'src/lib/sessionRepair.ts', 'const identity = await museSessionIdentity(path, root => sameDir(root, cwd))', 'const identity = null', golden),
    ('Muse waits on optional code', 'src/lib/sessionRepair.ts', 'const identity = await museSessionIdentity', "await (await import('../engines/inProcess.js')).loadEngine('muse')\n        const identity = await museSessionIdentity", eager),
    ('Read bound mistaken for absence', 'src/engines/kit/sessionIdentity.ts', "throw new IdentityReadUnavailable('the run identity exceeds the bounded read')", 'return null', bounded),
    ('One hold aborts discovery', 'src/core/agents/bind.ts', 'binding held · ${error instanceof Error ? error.message : error}`)\n        return null', 'binding held · ${error instanceof Error ? error.message : error}`)\n        throw error', bind),
    ('Stop capture erased by live snapshot', 'src/lib/stoppedAgents.ts', 'session = { ...session, transcriptPath: previous.transcriptPath }', 'session = { ...session, transcriptPath: null }', stop),
    ('Saved path crosses a conversation', 'src/lib/stoppedAgents.ts', 'session.sessionId === previous.sessionId && session.engine === previous.engine', 'session.engine === previous.engine', saved),
    ('Saved path crosses a process', 'src/lib/stoppedAgents.ts', '&& (session.hermesHome ?? null) === (previous.hermesHome ?? null)\n      && sameProcessIdentity(session.processIdentity, previous.processIdentity)', '&& (session.hermesHome ?? null) === (previous.hermesHome ?? null)\n      && !!session.processIdentity && !!previous.processIdentity', saved),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for name in ['TMUX', 'TMUX_PANE', 'RECORD_REPAIR_IDENTITY_GOLDEN']:
    env.pop(name, None)


def run(specs):
    # Ownership mutants need these focused regressions, not the unrelated 2,050-file catalog cost test.
    pattern = ['--testNamePattern=pathless observation|captured path'] if specs == [saved] else []
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, *pattern, '--maxWorkers=2'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


for specs in [[golden, eager, bounded, bind, stop], [saved]]:
    baseline = run(specs)
    if baseline.returncode:
        print(baseline.stdout + baseline.stderr)
        raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, spec in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            print(output)
            raise SystemExit(f'{label}: not caught by an assertion')
        print(f'{label}: caught by assertion', flush=True)
    finally:
        path.write_text(original)
