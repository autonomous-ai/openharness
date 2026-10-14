"""Assert the installed entry retains identity, bounded input and real cleanup."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
raw = 'hook/notify.mjs'
client = 'src/engines/kit/nativeNotifyCursor.ts'
artifact = 'src/nativeHookEntry.spec.ts'
unit = 'src/engines/kit/nativeNotifyCursor.spec.ts'
mutations = [
    ('native delivery falls through to legacy Stop', raw,
     [('runtime: paths().dataDir === initialDataDir ? originalRuntime : undefined })\n    return',
       'runtime: paths().dataDir === initialDataDir ? originalRuntime : undefined })')], artifact, 'shipped deadline'),
    ('bundle runs the legacy client instead', raw,
     [("if (engine === 'cursor' && options.nativeCursor)", "if (false && engine === 'cursor' && options.nativeCursor)")], artifact, 'unsupported generation'),
    ('client replaces the original delivery ID', client,
     [('id: context.id, firedAt: context.firedAt', "id: context.id + '-replacement', firedAt: context.firedAt")], unit, 'captures one original runtime'),
    ('client drops native generation identity', client,
     [('{ generationId: input.generation_id }', '{ generationId: sessionId }')], unit, 'preserves native identity'),
    ('client turns an abort into successful completion', client,
     [('{ status: input.status }', "{ status: 'completed' }")], unit, 'preserves native identity'),
    ('client drops exact response text', client,
     [('{ responseText: input.text }', "{ responseText: '' }")], unit, 'preserves native identity'),
    ('runtime authority is sampled after routing', client,
     [('const runtime = context.runtime', 'const runtime = nativeNotifyRuntime(context.dataDir, context.tmuxPane)')], artifact, 'owner changes during routing'),
    ('runtime authority crosses daemon routes', raw,
     [('runtime: paths().dataDir === initialDataDir ? originalRuntime : undefined', 'runtime: originalRuntime')], artifact, 'different data directory'),
    ('preprocessing renews the delivery allowance', client,
     [('timeoutMs: Math.max(0, deadline - performance.now())', 'timeoutMs: context.timeoutMs')], unit, 'does not renew'),
    ('bounded reply exits before actual cleanup', raw,
     [('process.exitCode = 0', 'process.exit(0)')], artifact, 'actual fsync cleanup'),
    ('incomplete input is treated as a complete event', raw,
     [('timer = setTimeout(() => finish(), 1000)', 'timer = setTimeout(() => finish(true), 1000)')], artifact, 'closes unfinished input'),
    ('invalid UTF-8 changes into replacement characters', raw,
     [("new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })", "new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })")], artifact, 'malformed UTF-8'),
    ('client retains metadata core cannot accept', client,
     [("if (!validNativeHookBody(body, true)) throw Error('The complete Cursor hook has unsupported metadata or exceeds a field limit.')", '')], unit, 'refuses unsupported metadata|checks individual'),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(spec, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=70)


for spec in [unit, artifact]:
    result = run(spec)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native notify baselines passed', flush=True)
failures = []
selected = os.environ.get('NATIVE_NOTIFY_MUTATIONS')
for label, filename, edits, spec, pattern in mutations:
    if selected and label not in selected.split('|'):
        continue
    path = cli / filename
    original = path.read_text()
    changed = original
    try:
        for before, after in edits:
            assert changed.count(before) == 1, (label, changed.count(before))
            changed = changed.replace(before, after)
        path.write_text(changed)
        result = run(spec, pattern)
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
