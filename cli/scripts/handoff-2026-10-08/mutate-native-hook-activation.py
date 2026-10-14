"""Production selection and retained launch proof must be causal, not snapshots."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
artifact = 'src/engines/kit/nativeHookArtifact.ts'
settings = 'src/engines/kit/nativeHookSettings.ts'
activation_spec = 'src/engines/nativeHookActivation.spec.ts'
artifact_spec = 'src/engines/kit/nativeHookArtifact.spec.ts'
mutations = [
    ('production installs the former protocol', 'src/engines/nativeHooks.ts',
     [('CURSOR_GENERATION_HOOK_SETTINGS', 'CURSOR_HOOK_SETTINGS')], activation_spec, 'installs the generated path', False),
    ('production drops the native response hook', 'src/engines/cursor/contract.ts',
     [("'preToolUse', 'afterAgentResponse', 'stop'", "'preToolUse', 'stop'")], activation_spec, 'installs the generated path', True),
    ('command points back to the raw compatibility script', 'src/engines/kit/notifyHooks.ts',
     [('environment, artifact.path)', 'environment)')], activation_spec, 'after the legacy formatter captured another layout', True),
    ('artifact proof is not checked during settings publication', settings,
     [('options.verify?.(); artifact.verify()', 'options.verify?.()')], activation_spec, 'during settings flush', True),
    ('artifact is absent from the serialized launch proof', settings,
     [('files: [...proof.files, ...artifact.proof.files]', 'files: [...proof.files]')], activation_spec, 'serialized post-rc guard', True),
    ('launch current ignores the artifact dependency', settings,
     [('current: () => proof.current() && artifact.proof.current()', 'current: () => proof.current()')], activation_spec, 'serialized post-rc guard', True),
    ('acknowledgement probes after the final owner deadline fence', settings,
     [('options.confirmed?.({ files:', 'artifact.verify(); options.confirmed?.({ files:')], activation_spec, 'final producer or joining acknowledgement', True),
    ('macOS prepares a client with no pinned helper', artifact,
     [("platform === 'darwin' && declaration[1] !== '1'", "false && platform === 'darwin' && declaration[1] !== '1'")], artifact_spec, 'requires the pinned helper', True),
    ('macOS credits a contradictory later capability', artifact,
     [("declaration[1] !== '1'", "!prefix.toString('utf8').includes('// harness-native-hook-darwin:1\\n')")], artifact_spec, 'contradictory later comment', True),
    ('source layout prefers the raw hook', artifact,
     [("join(directory, '..', '..', '..', 'dist', 'notify.mjs')", "join(directory, '..', '..', '..', 'hook', 'notify.mjs')")], artifact_spec, 'source layout', True),
    ('artifact version proof always succeeds', artifact,
     [('if (version(lstatSync(target, { bigint: true })) !== stamp)', 'if (false)')], artifact_spec, 'content changes', True),
    ('artifact route proof is disconnected', artifact,
     [('verifyNativePathFacts(facts)', 'void facts')], artifact_spec, 'existing package alias', True),
]
environment = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(environment):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        environment.pop(key)
assert Path(environment.get('TMUX_TMPDIR', '/missing')).is_dir(), 'Private TMUX_TMPDIR is required'


def run(spec, pattern=''):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', spec, '--maxWorkers=1',
                           *(['-t', pattern] if pattern else [])], cwd=cli, env=environment,
                          text=True, capture_output=True, timeout=60)


for spec in [activation_spec, artifact_spec]:
    result = run(spec)
    if result.returncode:
        raise SystemExit('Baseline failed; no mutants ran.\n' + result.stdout + result.stderr)
print('Native hook activation baselines passed', flush=True)
failures = []
for label, filename, edits, spec, pattern, exactly_once in mutations:
    path = cli / filename
    original = path.read_text()
    changed = original
    try:
        for before, after in edits:
            assert changed.count(before) == 1 if exactly_once else changed.count(before) > 0, (label, changed.count(before))
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
