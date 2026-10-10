"""Owned disposable worktree only; incomplete native evidence must assertion-fail."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
conversation = 'src/lib/nativeConversation.ts'
control = 'src/lib/nativeProcessControl.ts'
paths = 'src/engines/kit/nativePaths.ts'
header = 'src/engines/kit/nativeHeader.ts'
conversation_spec = 'src/lib/nativeConversation.spec.ts'
control_spec = 'src/lib/nativeProcessControl.spec.ts'
bounds = 'src/lib/sessionRepair.bounds.spec.ts'
golden = 'src/engines/nativeDescriptors.golden.spec.ts'
mutations = [
    ('optional discovery cooldown blocks control', control, 'bundledProcessImageHelper({ retryUnavailable: true })', 'bundledProcessImageHelper()', control_spec),
    ('inconclusive Darwin state rejected globally', 'src/lib/processEvidence.ts', '([?A-Za-z+<>NsLsl-]{1,8})', '([A-Za-z+<>NsLsl-]{1,8})', 'src/lib/processEvidence.spec.ts'),
    ('native finder disconnected', 'src/lib/sessionRepair.ts', 'return nativeOpenFileSession(engine, pid, typeof roots === \'string\' ? [roots] : roots, cwd, options)', 'return Promise.resolve(null)', golden),
    ('binding owner disconnected', 'src/core/agents/bind.ts', 'expectedProcess: observed.processIdentity,', '', 'src/core/agents/bind.spec.ts'),
    ('probe error prefix accepted', 'src/engines/kit/nativeEvidence.ts', 'if (error || stderr.length)', 'if (false)', 'src/engines/kit/nativeEvidence.spec.ts'),
    ('process graph EOF ignored', 'src/lib/processEvidence.ts', "if (!text || !text.endsWith('\\n'))", "if (text && !text.endsWith('\\n')) text += '\\n'; if (!text)", 'src/lib/processEvidence.spec.ts'),
    ('launcher child ignored', conversation, "return [parent.executable, parent.nativeArgv?.[0] ?? argvTokens(parent.args)[0] ?? '']", "return own.descriptors.length ? false : [parent.executable, parent.nativeArgv?.[0] ?? argvTokens(parent.args)[0] ?? '']", conversation_spec),
    ('ambiguous rollouts become absence', conversation, "if (found.size > 1) return nativeUnavailable('more than one open rollout could own the conversation')", 'if (found.size > 1) return null', conversation_spec),
    ('unknown source ignored', header, 'if (first.source)', 'if (false)', conversation_spec),
    ('child id ignored', conversation, "if (!('id' in store.byId) || !store.byId.id.test(meta.id)", "if (!meta.isSubagent && !('id' in store.byId) || !meta.isSubagent && !store.byId.id.test(meta.id)", conversation_spec),
    ('symlink target fence removed', paths, '|| target !== before.target', '|| false', conversation_spec),
    ('ordinary ancestor fence removed', paths, 'identity(now) !== identity(before.info)', "before.target !== undefined && identity(now) !== identity(before.info)", conversation_spec),
    ('workspace physical alias ignored', conversation, 'nativeFileKey(declared.info) === nativeFileKey(requested.info)', 'declared.path === requested.path', conversation_spec),
    ('cwd type ignored', conversation, "if ((declared && !declared.info.isDirectory()) || (requested && !requested.info.isDirectory()))", 'if (false)', conversation_spec),
    ('final joined evidence disconnected', conversation, 'await process.verifyDescriptors(new Map(pools.map(pool => [pool.pid, pool.proof.descriptors])), children[0]?.pid)', 'void 0', conversation_spec),
    ('lossless opened file key ignored', 'src/engines/kit/identityScan.ts', 'if (expected?.fileKey)', 'if (false)', bounds),
    ('header close loses typed hold', header, "nativeUnavailable('the native rollout header could not be closed')", "throw Error('fixture untyped close')", conversation_spec),
    ('nonleader children ignored', control, 'for (const task of tasks)', 'for (const task of tasks.filter(task => task === String(parent)))', control_spec),
    ('missing helper cache never invalidated', control, 'invalidateProcessImageHelper(helper.key)', 'void 0', control_spec),
    ('native control error prefix accepted', control, 'if (error || stderr.length)', 'if (false)', control_spec),
    ('final process-record claim disconnected', 'src/lib/captureResumeIdentity.ts', '  claim.verify()', '  void 0', bounds),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(env):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        env.pop(key)
if not Path(env.get('TMUX_TMPDIR', '/missing-private-tmux')).is_dir():
    raise SystemExit('An existing private TMUX_TMPDIR is required')


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=120)


baseline = run(sorted({target for _, _, _, _, target in mutations}))
if baseline.returncode:
    print(baseline.stdout + baseline.stderr)
    raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, target in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
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
