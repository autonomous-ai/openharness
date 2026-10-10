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
mutations = [
    ('parent repair disconnected', binding, 'selected = store.repairsOverwrittenParent && meta.parentThreadId === sessionId', 'selected = false', 'src/lib/bindingEvidence.golden.spec.ts'),
    ('saved binding file fence omitted', registry, 'try { proof.verify() }', 'try { void 0 }', loaded),
    ('root batch fence omitted', registry, 'try { proof?.verify() }', 'try { void 0 }', loaded),
    ('held retry disconnected', core, 'const retried = registry.revalidateBinding(agent.agentId)', 'const retried = agent', core_spec),
    ('held reason not exposed', core, 'if (registry.setIdentityHold(agent.agentId, reason)) announceSession(agent)', 'if (false) announceSession(agent)', core_spec),
    ('saved header id ignored', binding, 'meta.id !== sessionId', 'false', loaded),
    ('saved header read omitted', binding, 'const meta = proof.files.header(selected, store.first)', "const meta = { id: sessionId, isSubagent: false, parentThreadId: undefined }", loaded),
    ('opened file identity ignored', files, 'nativeFileKey(before) !== nativeFileKey(location.info)', 'false', primitive),
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
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(env):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        env.pop(key)
if not Path(env.get('TMUX_TMPDIR', '/missing-private-tmux')).is_dir():
    raise SystemExit('An existing private TMUX_TMPDIR is required')


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run(sorted({target for _, _, _, _, target in mutations}))
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
