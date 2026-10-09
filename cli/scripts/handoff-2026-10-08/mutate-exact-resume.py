"""Run only in an owned disposable worktree; every broken connection must assertion-fail."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
kit = 'src/engines/kit/exactTranscript.ts'
repair = 'src/lib/sessionRepair.ts'
spec = 'src/engines/kit/exactTranscript.spec.ts'
golden = 'src/engines/exactResume.golden.spec.ts'
mutations = [
    ('native declaration disconnected', 'src/engines/claude/sessionStore.ts', "byId: { layout: 'projects', suffix: '.jsonl' }", "byId: { layout: 'projects', suffix: '.missing' }", golden),
    ('Codex header id ignored', repair, 'meta.id === sessionId', 'true', spec),
    ('Pi workspace header ignored', repair, 'head.sessionId === sessionId && await workspaces.same(head.cwd, opts.cwd!)', 'true', golden),
    ('only first root inspected', kit, 'for (const root of roots) await walk(root)', 'for (const root of roots.slice(0, 1)) await walk(root)', spec),
    ('alias inspection errors become absent', kit, "if ((error as NodeJS.ErrnoException).code === 'ENOENT') return\n", 'return\n', spec),
    ('directory budget enlarged silently', kit, 'const budget = identityScanBudget(),', 'const budget = { remaining: 8192 },', spec),
    ('known home limit removed', kit, 'if (roots.length > 64)', 'if (false)', spec),
    ('candidate limit removed', kit, 'if (++candidates > 64)', 'if (false)', spec),
    ('depth limit removed', kit, 'if (depth > 32)', 'if (false)', spec),
    ('shared deadline removed', kit, 'if (performance.now() - started > 2000)', 'if (false)', spec),
    ('regular file check removed', kit, 'if (!info.isFile())', 'if (false)', spec),
    ('pool revalidation removed', kit, 'if (fingerprint(now) !== fingerprint(proof.info))', 'if (false)', spec),
    ('dangling alias evidence dropped', kit, '    proofs.push({ path, info, content: true })\n    return info?.isDirectory() ?? false', '    return info?.isDirectory() ?? false', spec),
    ('ambiguous files accepted', kit, 'if (selected.size > 1)', 'if (false)', spec),
    ('readability not checked', kit, 'await identityBytes(path, 1, info)', 'await Promise.resolve(Buffer.alloc(0))', spec),
    ('directory alias evidence omitted', kit, '    await inspectAliases(path)', '    // alias proof disconnected', spec),
    ('directory alias revalidation omitted', kit, 'if (signature(lstatSync(path)) !== signature(info))', 'if (false)', spec),
    ('relative link target normalized too early', kit, 'const targetParts = evidence.target.slice(targetRoot.length)', "const targetParts = resolve('/', evidence.target).slice(targetRoot.length)", spec),
    ('new native homes ignored', 'src/lib/sessionRepair.ts', "if (repairRoots(engine, opts?.codexHome).join('\\0') !== roots.join('\\0'))", 'if (false)', 'src/engines/kit/exactTranscript.spec.ts'),
    ('workspace proof not revalidated', 'src/engines/kit/exactTranscript.ts', '  options.verify?.()', '  // workspace revalidation disconnected', 'src/engines/kit/exactTranscript.spec.ts'),
    ('unavailable workspace excluded', 'src/engines/kit/exactTranscript.ts', "catch { throw new IdentityReadUnavailable('the Pi workspace identity could not be read') }", "catch { return '' }", 'src/engines/kit/exactTranscript.spec.ts'),
    ('Pi unreadable loses retry code', 'src/lib/sessionRepair.ts', "new IdentityReadUnavailable('the Pi conversation file could not be read', 'The Pi conversation file could not be read.')", "new Error('The Pi conversation file could not be read.')", 'src/lib/closeAgentService.spec.ts'),
    ('Pi ambiguous loses retry code', 'src/engines/kit/exactTranscript.ts', 'new IdentityReadUnavailable(options.ambiguous, options.ambiguous)', 'new Error(options.ambiguous)', 'src/lib/closeAgentService.spec.ts'),
    ('checkpoint swallows identity hold', 'src/lib/sessionCheckpoint.ts', "error instanceof SessionCheckpointError || (error as { code?: unknown } | null)?.code === 'IDENTITY_UNAVAILABLE'", 'error instanceof SessionCheckpointError', 'src/lib/sessionCheckpoint.spec.ts'),
    ('opened candidate version ignored', 'src/engines/kit/identityScan.ts', 'if (expected && (before.dev', 'if (false && (before.dev', 'src/engines/kit/exactTranscript.spec.ts'),
    ('matching-name unknown child excluded', 'src/lib/sessionRepair.ts', "if (!meta?.id || !byId.id.test(meta.id)) throw new IdentityReadUnavailable('the exact rollout header has no conclusive conversation id')", 'if (!meta?.id || !byId.id.test(meta.id)) return false', 'src/engines/kit/exactTranscript.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(env):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        env.pop(key)
if not Path(env.get('TMUX_TMPDIR', '/missing-tmux-fixture')).is_dir():
    raise SystemExit('An existing private TMUX_TMPDIR is required')


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=2'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=120)


baseline = run([spec, golden, 'src/lib/sessionCheckpoint.spec.ts', 'src/lib/closeAgentService.spec.ts'])
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
