"""A retained Cancel must precede publication and grant at most one fresh interrupt."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
server = cli / 'src/hookServer.ts'
spec = 'src/hookServer.nativeProtocol.spec.ts'
mutations = [
    ('Cancel adopts mutable caller data', [
        ('request = structuredClone(value)', 'request = value')], 'native Cancel before interrupting'),
    ('Cancel accepts another request owner', [
        ('!validNativeGenerationCancellation(request) || request.agentId !== original.agentId || request.conversationId !== original.sessionId',
         '!validNativeGenerationCancellation(request)')], 'native Cancel without a confirmed write'),
    ('Cancel does not publish its retained barrier', [
        ('nativeGenerationState(original, true, verifyRetained)', 'nativeGenerationState(original, false, verifyRetained)')], 'native Cancel before interrupting'),
    ('Cancel adopts a replacement publication identity', [
        ('      retained.verify()\n      if (JSON.stringify(source.cancellations', '      if (JSON.stringify(source.cancellations')],
     'native Cancel before notification.*replaced|native Cancel identity on an exact retry'),
    ('Cancel accepts a source missing its barrier', [
        ('JSON.stringify(source.cancellations?.find(saved => saved.requestId === request.requestId)) !== JSON.stringify(request)', 'false')],
     'native Cancel before notification.*source omitted'),
    ('Cancel notifies before checking its original binding', [
        ('      publicationGuard?.(source)\n      verify()\n      if (publish)', '      verify()\n      if (publish)')],
     'native Cancel to a conversation rebound'),
    ('empty Cancel loss restores readiness before rejection', [
        ('!publish || publicationGuard || snapshot.cancellations.size', '!publish || snapshot.cancellations.size')],
     'native Cancel before notification.*lost'),
    ('interrupt reuses expired native evidence', [
        ('const fresh = await readNativeGenerations(original)', 'const fresh = after.source')], 'native Cancel before interrupting'),
    ('interrupt proceeds during pending admission', [
        ("if (state.pending) throw new IdentityReadUnavailable('native generation admission is still pending')", '')],
     'native Cancel during pending admission'),
    ('delayed interrupt loses its effect boundary guard', [
        ('return effect(verify)', 'return effect(() => {})')], 'revokes native Cancel at the delayed interrupt'),
    ('retry invents another interrupt capability', [
        ('return { recorded: false, source: after.source }', 'return { recorded: false, source: after.source, dispatch: async () => {} }')],
     'native Cancel after restart'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(pattern):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec, '--maxWorkers=1', '-t', pattern],
                          cwd=cli, env=environment, text=True, capture_output=True, timeout=95)


baseline = run('native Cancel')
if baseline.returncode:
    raise SystemExit('Baseline failed; no mutants ran.\n' + baseline.stdout + baseline.stderr)
print('Native Cancel port baseline passed', flush=True)
failures = []
for label, edits, pattern in mutations:
    original = server.read_text()
    changed = original
    for before, after in edits:
        assert changed.count(before) == 1, (label, changed.count(before))
        changed = changed.replace(before, after)
    try:
        server.write_text(changed)
        result = run(pattern)
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            failures.append(label)
            print(label + ': not caught by an assertion\n' + output, flush=True)
        else:
            print(label + ': caught by assertion', flush=True)
    finally:
        server.write_text(original)
if failures:
    raise SystemExit('Mutations without assertion proof: ' + ', '.join(failures))
