#!/usr/bin/env python3
"""Run in a disposable worktree: healthy golden and durable-authority mutations."""
from pathlib import Path
import os
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/core/agents/launchRequests.golden.spec.ts'
receipt = 'src/lib/agentCreationReceipt.spec.ts'
requests = 'src/core/agents/launches.spec.ts'
scheduler = 'src/core/agents/pendingLaunches.spec.ts'
startup = 'src/startupOrder.spec.ts'
initial = 'src/lib/initialLaunch.golden.spec.ts'
reconciler = 'src/lib/terminalAgentReconciler.spec.ts'
mutations = [
    ('drop resolved model', 'src/core/agents/launches.ts', '    input.grid = target\n    return () => executeCreate', '    input.grid = null\n    return () => executeCreate', golden),
    ('drop Codex profile', 'src/core/agents/launches.ts', '      codexHome,\n      dsh,', '      codexHome: null,\n      dsh,', golden),
    ('wrong project label', 'src/core/agents/launches.ts', '?? engineLabel(input.engine)', "?? 'Wrong fixture label'", golden),
    ('lose created identity', 'src/core/agents/launches.ts', 'byAgent(status.agentId)', "byAgent('missing-created-agent')", golden),
    ('omit legacy reservation', 'src/lib/agentCreationReceipt.ts', "this.write(id, { version: 1, fingerprint, outcome: { state: 'pending' } }, true)", 'void id', golden),
    ('forget saved authorization', 'src/core/agents/launches.ts', 'saved.local as boolean, invoke)', 'true, invoke)', requests),
    ('forget intent identity after await', 'src/lib/agentCreationReceipt.ts', 'const current = this.read(id)', 'const current = saved', receipt),
    ('forget directory identity', 'src/lib/agentCreationReceipt.ts', '      directory.verify()', '      void directory', receipt),
    ('hide conflicting disk result', 'src/lib/agentCreationReceipt.ts', '    if (result) {\n      if (result.fingerprint', '    if (known) return known.outcome\n    if (result) {\n      if (result.fingerprint', receipt),
    ('forget completion before missing evidence', 'src/lib/agentCreationReceipt.ts', 'const completedIntent = this.intentResults.has(id)', 'const completedIntent = false', receipt),
    ('drop cancellation claim', 'src/lib/agentCreationReceipt.ts', "this.publish(this.intentFile(id, 'claim'), { fingerprint: receipt.fingerprint, token: randomUUID(), kind: 'cancel' }, true)", 'void receipt', receipt),
    ('unbounded retry window', 'src/core/agents/pendingLaunches.ts', 'const windowSize = 128', 'const windowSize = 1_000_000', scheduler),
    ('omit retry read budget', 'src/core/agents/pendingLaunches.ts', 'started < 4 && !stopped && performance.now() - began < 20', 'started < 4 && !stopped', scheduler),
    ('recover manual launches before readiness', 'src/core/main.ts', '  coreLink.ready()', '  launches.open()\n  coreLink.ready()', startup),
    ('misroute confirmed engine exits', 'src/lib/terminalAgentReconciler.ts', 'await this.deps.onDormant(current,', 'await this.deps.onRemoved(current,', initial),
    ('retire an initial launch before its engine exists', 'src/lib/terminalAgentReconciler.ts', "if (observed || (processKey === null && (current.launch?.state === 'starting' || probed?.starting)))", 'if (observed)', reconciler),
    ('apply a pre-start miss after readiness changes', 'src/lib/terminalAgentReconciler.ts', "current.launch?.state === 'starting' || probed?.starting", "current.launch?.state === 'starting'", reconciler),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for name in ['TMUX', 'TMUX_PANE', 'RECORD_LAUNCH_REQUESTS_GOLDEN']:
    env.pop(name, None)


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run([golden, receipt, requests, scheduler, startup, initial, reconciler])
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
