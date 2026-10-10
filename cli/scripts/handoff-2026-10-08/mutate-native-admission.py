"""Owned disposable worktree only. A passing baseline and assertion failure are mandatory."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
http = 'src/hookServer.ts'
queue = 'src/core/engines/pendingAdmission.ts'
spec = 'src/lib/registry.admission.spec.ts'
mutations = [
    ('registration grants stale readers the new binding', registry,
     'replaceLive: true', 'replaceLive: false', 'src/lib/runtimeProfileRegistry.spec.ts', ''),
    ('registration publishes before durability', registry,
     'this.save(true, false, undefined, { agentId, candidate: entry, displaced, replaceLive: true, verify: () => proof?.verify() })',
     'this.agents.set(agentId, entry); this.save(true, false, undefined, { agentId, candidate: entry, displaced, replaceLive: true, verify: () => proof?.verify() })', spec, 'failure|fails|failed'),
    ('displaced owner changes before commit', registry,
     'displaced = { agentId: stolenFrom.agentId, candidate: stolenFrom.active ? released : null }',
     'this.agents.set(stolenFrom.agentId, released); displaced = { agentId: stolenFrom.agentId, candidate: stolenFrom.active ? released : null }', spec, 'failure|fails|failed'),
    ('registration native recheck omitted', registry,
     'this.save(true, false, undefined, { agentId, candidate: entry, displaced, replaceLive: true, verify: () => proof?.verify() })',
     'this.save(true, false, undefined, { agentId, candidate: entry, displaced, replaceLive: true, verify: () => {} })', spec, 'under|proof'),
    ('reported path borrows unwritten locator authority', registry,
     "!transcriptPath && derived === effectiveTranscriptPath ? 'derived' : false", "'derived'", spec, 'unwritten derived locator'),
    ('unwritten locator accepts a dangling directory', 'src/engines/transcriptBindings.ts',
     'if (suffix.length && !files.paths.absentLeaf(join(location.path, suffix[0])))', 'if (false)',
     'src/engines/transcriptBindings.spec.ts', 'dangling directory'),
    ('unconfirmed serialized image stays mutable', registry,
     'image: JSON.parse(JSON.stringify(serialized)), prior: JSON.parse(JSON.stringify([...prior.values()]))',
     'image: serialized, prior: [...prior.values()]', spec, 'mutable|nested'),
    ('peer ownership recovery skips displaced draft', registry,
     '|| bindingCommit?.displaced !== undefined && unconfirmed.affected.has(bindingCommit.displaced.agentId)',
     '|| false', spec, 'displaced-owner'),
    ('prompt credit disconnected', http,
     "optional(() => handlers.onPromptSubmitted?.(result.entry.agentId, body.prompt ?? ''))", 'void 0', 'src/hookAdmission.golden.spec.ts', ''),
    ('first admission notification disconnected', http,
     "optional(() => handlers.onRegistered(result.entry, { isNew: result.isNew, evicted: result.evicted, rebound: result.rebound,\n            orphaned: result.orphaned, hookEvent: body.hookEvent }))", 'void 0', 'src/hookAdmission.golden.spec.ts', ''),
    ('commit failure loses queued delivery', queue,
     "catch (error) { decision = { kind: 'hold', reason: `Waiting for durable hook admission:",
     "catch (error) { decision = { kind: 'reject', reason: `Waiting for durable hook admission:", 'src/core/engines/pendingAdmission.spec.ts', 'durable commit'),
    ('conversation FIFO disconnected', queue,
     'return newest && queue!.find(job => conversation(job) === conversation(newest))',
     'return newest', spec, 'held predecessor'),
    ('delegated peer is never revisited', queue,
     'const peer = leaders(key, job).find(other => conversation(other) !== conversation(job))',
     'const peer: Job | undefined = undefined', 'src/core/engines/pendingAdmission.spec.ts', 'rechecks an already-held equal-time child'),
    ('native order ignored', queue,
     'const status = order.status(key, conversation(job), job.request.order)',
     "const status: string = 'current'", spec, 'delayed older'),
    ('duplicate completion acknowledgement ignored', http,
     'const completed = history.records.get(deliveryId)', "const completed = history.records.get('fixture-missing-delivery')", spec, 'acknowledges a repeated delivery'),
    ('completed acknowledgement tied to routes', http,
     'row.agentId, row.engine, row.processIdentity ? processIdentityKey(row.engine, row.processIdentity) : null,',
     'row.agentId, row.engine, row.processIdentity ? processIdentityKey(row.engine, row.processIdentity) : null, row.runtimes, row.primaryRuntimeKey,',
     spec, 'completed delivery acknowledgement'),
    ('payload backpressure disconnected', http,
     'receiptBytes + retainedBytes > bytesCapacity', 'false', spec, 'payload bytes'),
    ('matched process snapshot is still live', 'src/core/engines/hooks.ts',
     'const candidate = structuredClone(live)', 'const candidate = live', spec, 'resolver continuation'),
    ('inspection binding authority ignored', http,
     'if (!current() || paneReadIdentity(live()) !== inspectionIdentity)', 'if (!current())', 'src/hookServer.hermes.spec.ts', 'known home changes during source inspection'),
    ('Stop admission fence disconnected', http,
     'if (handlers.hookAdmissionBlocked?.(processAgent.agentId))', 'if (false)', spec, 'actual Stop job'),
    ('unmatched Stop claim forgotten', http,
     'if (stopUnmatched && !stopRetained)', 'if (false)', spec, 'retains .* Stop before'),
    ('linked Stop invocation duplicated', http,
     'if (stopInvocationClaimed) return { status: 200, reply: { ok: true, duplicate: true } }',
     'stopInvocationClaimed = false', spec, 'claims an immediate'),
    ('missing parser loses native completion', 'src/core/transcripts/attach.ts',
     '!unmatched && normalizers.sessionTurnState(session.sessionId) !== undefined', '!unmatched',
     'src/core/transcripts/attach.spec.ts', 'catch-hook completion'),
    ('pending Stop erases Cursor tasks', 'hook/notify.mjs',
     "if (path === '/api/hook/turn-stop' && ok && reply?.pending === true) { resolve('held'); return }", '',
     'src/hookNotify.spec.ts', 'Cursor Task/stop'),
    ('remaining admission hold hidden', http,
     "const reason = [...admissionHolds.get(processAgent.agentId)?.values() ?? []].at(-1)",
     'const reason = undefined', spec, 'older hold visible'),
    ('overtaking resolution forgets Stop', http,
     'if (stopProvenance(stop, firedAt) !== originalStop) return conflict\n          deferred = true',
     'if (stopProvenance(stop, firedAt) !== originalStop) return conflict', spec, 'overtaking Stop'),
    ('queued parser reconstruction grants completion', 'src/core/transcripts/attach.ts',
     '&& !pendingAttaches.has(session.sessionId)', '', 'src/core/transcripts/attach.spec.ts', 'existing interpretation has a queued'),
    ('same-owner reconstruction loses completion', http,
     'stopRetained = handlers.onAdmissionStop?.(live()!, true) ?? false', 'stopRetained = false', spec, 'same-owner linked Stop'),
    ('duplicate Stop erases Cursor tasks', 'hook/notify.mjs',
     "if (path === '/api/hook/turn-stop' && ok && reply?.duplicate === true) { resolve('duplicate'); return }", '',
     'src/hookNotify.spec.ts', 'Cursor Task/stop'),
    ('refused registration falls through to Stop', http,
     "if (/^[a-zA-Z0-9_-]{16,96}$/.test(delivery) && (body.engine === 'cursor' || body.engine === 'commandcode'))",
     'if (false)', spec, 'bypass refused admission'),
    ('Cancel witness wiring disconnected', 'src/core/main.ts',
     'captureAdmissionStop: attach.captureAdmissionStop,', '', 'e2e/hookclient.e2e.ts', 'later Cursor turn open'),
    ('admission status wiring disconnected', 'src/core/main.ts',
     'onAdmissionHeld: engineHooks.onAdmissionHeld,', '', 'e2e/hookclient.e2e.ts', 'real native prompt visibly held'),
]
selected = set(sys.argv[2:])
if selected:
    assert selected <= {entry[0] for entry in mutations}, 'Unknown mutation label'
    mutations = [entry for entry in mutations if entry[0] in selected]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(targets, pattern=''):
    native = any(target.startswith('e2e/') for target in targets)
    lane = ['--config', 'vitest.e2e.config.ts'] if native else []
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *lane, *targets,
                           *(['--testNamePattern', pattern] if pattern else []), '--maxWorkers=1'],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


for native in [False, True]:
    targets = sorted({entry[4] for entry in mutations if entry[4].startswith('e2e/') == native})
    if targets:
        baseline = run(targets, 'real native prompt visibly held|later Cursor turn open' if native else '')
        if baseline.returncode:
            raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, target, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    expected = 2 if label in ['Stop admission fence disconnected', 'linked Stop invocation duplicated'] else 1
    assert original.count(before) == expected, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([target], pattern)
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
