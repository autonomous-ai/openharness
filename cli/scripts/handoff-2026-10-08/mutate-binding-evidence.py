"""Run only in an owned disposable worktree: every broken binding fence must fail an assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
registry = 'src/lib/registry.ts'
binding = 'src/engines/transcriptBindings.ts'
files = 'src/engines/kit/nativeFiles.ts'
paths = 'src/engines/kit/nativePaths.ts'
primitive = 'src/engines/transcriptBindings.spec.ts'
loaded = 'src/lib/registry.binding.spec.ts'
core = 'src/core/agents/bind.ts'
core_spec = 'src/core/agents/bind.spec.ts'
controls = 'src/core/transcripts/attach.control.spec.ts'
mutations = [
    ('parent repair disconnected', binding, 'selected = store.repairsOverwrittenParent && meta.parentThreadId === sessionId', 'selected = false', 'src/lib/bindingEvidence.golden.spec.ts'),
    ('saved binding file fence omitted', registry, 'try { proof.verify() }', 'try { void 0 }', loaded),
    ('root batch fence omitted', registry, 'try { proof?.verify() }', 'try { void 0 }', loaded),
    ('held retry disconnected', core, 'const retried = registry.revalidateBinding(agent.agentId)', 'const retried = agent', core_spec),
    ('held reason not exposed', core, 'if (registry.setIdentityHold(agent.agentId, reason)) announceSession(agent)', 'if (false) announceSession(agent)', core_spec),
    ('saved header id ignored', binding, 'meta.id !== sessionId', 'false', loaded),
    ('saved header read omitted', binding, 'const meta = proof.files.header(selected, store.first)', "const meta = { id: sessionId, isSubagent: false, parentThreadId: undefined }", loaded),
    ('opened file identity ignored', files, '!before.isFile() || nativeFileKey(before) !== nativeFileKey(location.info)', '!before.isFile() || false', primitive),
    ('final header change ignored', files, 'firstLine(bytes, record.limit - 1) !== record.line', 'false', primitive),
    ('repeated header evidence replaced', files, 'earlier.line !== line', 'false', primitive),
    ('final ancestry ignored', paths, 'identity(now) !== identity(before.info)', 'false', primitive),
    ('announced parent owner ignored', binding, 'parent.info.uid !== BigInt(process.getuid())', 'false', primitive),
    ('dangling leaf accepted', binding, '!files.paths.absentLeaf(join(parent.path, basename(path)))', 'false', primitive),
    ('repaired file root ignored', binding, '!files.paths.within(file.path, roots.map(root => root.info))', 'false', primitive),
    ('repaired directory root ignored', binding, '!files.paths.within(location.path, roots.map(root => root.info))', 'false', primitive),
    ('ambiguous parent accepted', binding, 'selected.size > 1', 'false', primitive),
    ('parent pool final stamp ignored', files, 'stamp(lstatSync(path, { bigint: true })) !== before', 'false', primitive),
    ('ancestor round trip ignored', files, 'route.size !== after.size || [...route].some(([part, version]) => after.get(part) !== version)', 'false', primitive),
    ('recovery does not reset parser', core, 'const reset = meta.isNew || !!meta.recovered', 'const reset = meta.isNew', 'src/core/transcripts/attach.spec.ts'),
    ('recovery replays saved first turn', core, '!meta.recovered && !resumedConversation', '!resumedConversation', 'src/core/transcripts/attach.spec.ts'),
    ('released input loses agent key', 'src/core/agents/forget.ts', 'input.forget(announceId)', 'input.forget(sessionId)', 'src/core/agents/forget.spec.ts'),
    ('durable binding comparison omitted', registry, '!== this.persistedBaseline.get(bindingCommit.agentId)', '!== this.persistedBaseline.get(bindingCommit.agentId) && false', loaded),
    ('native commit fence omitted', registry, 'bindingCommit.verify()', 'void 0', loaded),
    ('held attachment admitted', 'src/core/transcripts/attach.ts', 'if (session.identityHold) return Promise.resolve(true)', 'if (false) return Promise.resolve(true)', 'src/core/transcripts/attach.spec.ts'),
    ('held replies retain authority', 'src/core/transcripts/readIdentity.ts', "...(session.identityHold ? ['identity-held'] : [])", '...[]', 'src/core/transcripts/attach.spec.ts'),
    ('held line is interpreted', 'src/core/transcripts/ingest.ts', 'session.identityHold || ', '', 'src/core/transcripts/ingest.spec.ts'),
    ('Cancel admission disconnected', 'src/core/turns/cancel.ts', 'if (record) beforeCancel?.(record)', 'if (false) beforeCancel?.(record!)', controls),
    ('first ordinary Cancel is forgotten', 'src/core/transcripts/attach.ts', 'session.transcriptPath || turnReplacements.retains(session)', 'turnReplacements.retains(session)', controls),
    ('Stop retention disconnected', 'src/core/turns/turnHooks.ts', 'retained = holdStop(latest, changed)', 'retained = true', controls),
    ('ordinary successful Stop is forgotten', 'src/core/turns/turnHooks.ts', 'afterStop?.(resolve(sessionId)!)', 'void 0', controls),
    ('retained cancellation discarded after recovery', 'src/core/transcripts/turnReplacement.ts', 'if (!boundaries.length && !stopRevision) pending.delete(id)', 'pending.delete(id)', controls),
    ('cancellation follows old path spelling', 'src/core/transcripts/turnReplacement.ts', 'JSON.stringify([session.agentId, id, session.engine])', 'JSON.stringify([session.agentId, id, session.engine, session.transcriptPath])', controls),
    ('inline cancellation replay disconnected', 'src/core/transcripts/attach.ts', 'parser!.closeTurn(reason); historyExplicitlyClosed = true', 'historyExplicitlyClosed = true', controls),
    ('worker request drops cancellation boundaries', 'src/engines/worker/liveRequests.ts', '...(payload.closes === undefined ? {} : { closes: payload.closes })', '...{}', controls),
    ('worker cancellation replay disconnected', 'src/engines/worker/liveStreams.ts', 'closeThrough: replayCloses(ask.closes ?? [], reason => {', 'closeThrough: replayCloses([], reason => {', controls),
    ('worker boundary failure loses its reason', 'src/engines/worker/liveRequests.ts', "'ENGINE_TRANSCRIPT_CHANGED', 'ENGINE_CONTROL_BOUNDARY_CHANGED'", "'ENGINE_TRANSCRIPT_CHANGED'", controls),
    ('replay descriptor fence omitted', 'src/lib/transcriptBoundary.ts', '!actual.isFile() || actual.dev !== expected.device || actual.ino !== expected.inode', 'false', controls),
    ('ordinary database Cancel starts a file hold', 'src/core/transcripts/attach.ts', 'if (reason && session.transcriptPath)', 'if (reason)', 'src/core/transcripts/attach.spec.ts'),
    ('legacy open-turn snapshot ignored', 'src/core/transcripts/turnReplacement.ts', 'turnOpen: normalizers.sessionTurnState(id) ?? false', 'turnOpen: false', controls),
    ('retained legacy open turn ignored', 'src/core/transcripts/turnReplacement.ts', 'normalizers.sessionTurnState(id) ?? state.turnOpen', 'state.turnOpen', controls),
    ('core Cancel wiring disconnected', 'src/core/main.ts', 'beforeCancel: attach.beforeCancel,', '', 'e2e/enginehomes.e2e.ts'),
]
# A receipt can reuse unaffected mutants while a changed composed assertion runs again.
selected = set(sys.argv[2:])
if selected:
    assert selected <= {label for label, *_ in mutations}, 'Unknown mutation label'
    mutations = [entry for entry in mutations if entry[0] in selected]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(env):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        env.pop(key)
if not Path(env.get('TMUX_TMPDIR', '/missing-private-tmux')).is_dir():
    raise SystemExit('An existing private TMUX_TMPDIR is required')


def run(specs):
    e2e = any(spec.startswith('e2e/') for spec in specs)
    lane = ['--config', 'vitest.e2e.config.ts', '--testNamePattern', 'retains a saved binding with an incomplete header'] if e2e else []
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *lane, *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=300 if e2e else 180)


for e2e in [False, True]:
    specs = sorted({target for _, _, _, _, target in mutations if target.startswith('e2e/') == e2e})
    if not specs:
        continue
    baseline = run(specs)
    if baseline.returncode:
        print(baseline.stdout + baseline.stderr)
        raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, target in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == (2 if label == 'held reason not exposed' else 1), (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([target])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            print(output)
            raise SystemExit(f'{label}: not caught by an assertion')
        print(f'{label}: caught by assertion', flush=True)
    finally:
        path.write_text(original)
