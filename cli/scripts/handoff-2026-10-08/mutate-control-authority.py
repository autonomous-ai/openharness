"""Run only in an owned disposable worktree. Every mutant must fail an assertion."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
assert (cli.parent / '.git').is_file(), 'An owned disposable worktree is required'
assert os.environ.get('HARNESS_CONTROL_MUTATIONS_OWNED') == '1', 'Explicit owned-worktree marker is required'
control = 'src/lib/controlTranscript.spec.ts'
bindings = 'src/engines/transcriptBindings.ts'
checkpoint = 'src/lib/sessionCheckpoint.ts'
stop = 'src/lib/stopAgentService.ts'
resume = 'src/lib/resumeAgentService.ts'
mutations = [
    ('legacy capture accepts an unusable saved conversation', 'src/lib/captureResumeIdentity.ts',
     "return nativeUnavailable('the saved conversation file is unavailable')", 'return session',
     'src/engines/sessionStore.golden.spec.ts', 'homes, transcripts, finders'),
    ('capture omits eager identity', 'src/lib/captureResumeIdentity.ts',
     'if (proof.path) controlTranscriptEvidence(session.engine, id, proof.path, options.codexHome, session.cwd).verify()',
     'void proof', control, 'eagerly checks the saved claude'),
    ('positive native claim is discarded', 'src/lib/captureResumeIdentity.ts',
     "if (keepsFile && !transcriptPath) return nativeUnavailable('the observed conversation file is unavailable')",
     'if (keepsFile && !transcriptPath) return session', 'src/lib/captureResumeIdentity.spec.ts', 'announced conversation|ambiguous or unsafe'),
    ('capture path wiring disconnected', 'src/lib/captureResumeIdentity.ts',
     'if (path) return path === session.transcriptPath ? session : { ...session, transcriptPath: path }',
     'if (path) return { ...session, transcriptPath: null }', 'src/lib/controlTranscript.golden.spec.ts', ''),
    ('control accepts a replacement inode', bindings,
     'after.fileKey !== before.fileKey', 'false', control, 'physically replaced'),
    ('copy descriptor borrows pathname authority', bindings,
     'openedFileKey !== undefined && openedFileKey !== before.fileKey', 'false', control, 'ancestor that moves away and back'),
    ('Claude control header omitted', bindings,
     "engine === 'claude' ? claudeIdentity", "engine === 'claude' ? undefined", control, 'eagerly checks the saved claude'),
    ('opening borrows a different physical file', bindings,
     'head.fileKey !== proof.fileKey', 'false', control, 'lend its valid opening'),
    ('contradictory delegation is ignored', 'src/engines/kit/controlIdentity.ts',
     'side !== undefined && valueSide !== undefined && valueSide !== side', 'false', 'src/engines/kit/controlIdentity.spec.ts', 'contradictory Claude'),
    ('Pi workspace authority omitted', bindings,
     'if (rule.canonicalWorkspace)', 'if (false)', control, 'eagerly checks the saved pi'),
    ('opening changes are not fenced', 'src/engines/kit/nativeFiles.ts',
     'record.prefix && !bytes.equals(record.prefix)', 'false', 'src/engines/kit/controlIdentity.spec.ts', 'complete opening proof'),
    ('reusable source snapshot predates await', checkpoint,
     "before = await input.stat({ bigint: true }).catch(() => { throw new IdentityReadUnavailable('the source transcript became unreadable') })",
     'void before', control, 'newly appended body'),
    ('same-size body replacement is reused', checkpoint,
     '&& previous.sourceCtime === String(before.ctimeNs)', '', control, 'same-sized history'),
    ('checkpoint native hold becomes failure', checkpoint,
     " || (error as { code?: unknown } | null)?.code === 'IDENTITY_UNAVAILABLE'", '', control, 'unavailable source'),
    ('checkpoint draft wiring disconnected', checkpoint,
     'if (options.screen != null && s.sessionId)', 'if (false)', 'src/lib/controlTranscript.golden.spec.ts', ''),
    ('Stop accepts a changed binding', stop,
     '(binding === undefined || bindingIdentity(current!) === binding)', 'true', control, 'binding boundary'),
    ('Stop forgets precise process birth', stop,
     ', entry.processIdentity?.startTicks', '', control, 'process birth boundary'),
    ('native broker hides the Stop hold', stop,
     '.catch(error => { throw nativeIdentityError ?? error })', '', control, 'native broker contains'),
    ('contained native errors lose their hold', stop,
     'if (nativeIdentityError) throw nativeIdentityError', 'void nativeIdentityError', control, 'contained grant|process signal'),
    ('signal skips fresh transcript proof', stop,
     'kill: (pid, signal) => {\n              verifyTranscript()', 'kill: (pid, signal) => {', control, 'process signal'),
    ('forget drops the proven parent path', stop,
     'forgetSession(sessionId, { force: true, captured: s })', 'forgetSession(sessionId, { force: true })', control, 'final real forget'),
    ('Resume configuration loses its source fence', resume,
     'relaunchOverrides(saved, saved, sourceCurrent)', 'relaunchOverrides(saved, saved, () => true)', control, 'during configuration'),
    ('Resume actual dispatch fence disconnected', resume,
     'current: sourceCurrent,', '', control, 'during tmux dispatch'),
    ('Resume dispatch ignores a new conversation owner', resume,
     'if (saved.sessionId && registry.bySession(saved.sessionId)) {', 'if (false) {', control, 'during conversation ownership'),
    ('Resume dispatch uncertainty is forgotten', resume,
     'onDispatch: () => { allocationAttempted = true }', 'onDispatch: () => {}', 'src/lib/resumeAgentService.spec.ts', 'dispatch starts but loses'),
    ('Resume repair wiring disconnected', resume,
     'try { prepareSessionResume(saved) }', 'try { void saved }', 'src/lib/controlResume.golden.spec.ts', ''),
    ('Resume argv loses conversation', resume,
     'resumeSessionId,\n          bypassPermission:', 'resumeSessionId: undefined,\n          bypassPermission:', 'src/lib/controlResume.golden.spec.ts', ''),
    ('Close accepts an unconfirmed drain', 'src/core/agents/close.ts',
     "if (code === 'ENGINE_TRANSCRIPT_CHANGED') throw new IdentityReadUnavailable('the transcript changed while checking activity')",
     "if (code === 'ENGINE_TRANSCRIPT_CHANGED') return", 'src/core/agents/close.spec.ts', ''),
    ('Close activity hold becomes failed', 'src/lib/closeAgentService.ts',
     "{ ...plan, state: 'waiting',\n              detail: error", "{ ...plan, state: 'failed',\n              detail: error",
     'src/lib/closeAgentService.spec.ts', 'queued Close visible'),
    ('Close reason failure escapes retry', 'src/lib/closeAgentService.ts',
     'catch { /* The preceding durable intent survives a failed reason update. Retry next tick. */ }',
     'catch (error) { throw error }', 'src/lib/closeAgentService.spec.ts', 'failed Close reason'),
]
selected = set(sys.argv[2:])
if selected:
    assert selected <= {entry[0] for entry in mutations}, 'Unknown mutation'
    mutations = [entry for entry in mutations if entry[0] in selected]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(targets, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *targets,
                           *(['--testNamePattern', pattern] if pattern else []), '--maxWorkers=1'],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=180)


baseline = run(sorted({entry[4] for entry in mutations}))
if baseline.returncode:
    raise SystemExit('Unchanged baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Unchanged baselines passed', flush=True)
failures = []
for label, relative, before, after, target, pattern in mutations:
    path = cli / relative
    original = path.read_text()
    expected = 2 if label == 'contained native errors lose their hold' else 1
    assert original.count(before) == expected, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([target], pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        path.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
