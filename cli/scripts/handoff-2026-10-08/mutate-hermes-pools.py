"""Every broken Hermes control connection must assertion-fail in a disposable worktree."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
pool = 'src/engines/kit/storePool.ts'
spec = 'src/engines/kit/storePool.spec.ts'
hook = 'src/hookServer.ts'
hook_spec = 'src/hookServer.hermes.spec.ts'
golden = 'src/engines/hermesIdentity.golden.spec.ts'
mutations = [
    ('repair lookup disconnected', 'src/lib/sessionRepair.ts', 'const found = await readStorePool(HERMES_HOMES, env.HERMES_HOME, {', 'const found = await readStorePool(HERMES_HOMES, `${env.HERMES_HOME}/missing`, {', golden),
    ('store declaration disconnected', 'src/engines/hermes/contract.ts', "return join(home, 'state.db')", "return join(home, 'missing.db')", golden),
    ('source declaration disconnected', 'src/engines/hermes/contract.ts', 'SELECT substr(source, 1, 129) AS source', "SELECT 'tool' AS source", golden),
    ('unbounded profile pool', pool, 'remaining: declared.max + 1', 'remaining: 4096', spec),
    ('unreadable query means empty', pool, "if (!result.ok) unavailable('a native store query is unavailable')", 'if (!result.ok) continue', spec),
    ('multiple rows mean empty', pool, 'for (const row of result.rows) found.push', 'if (result.rows.length === 1) for (const row of result.rows) found.push', spec),
    ('incomplete paths mean absent', pool, "if (!missing(error)) unavailable('a native store path could not be inspected')", 'if (false) throw error', spec),
    ('changed pool accepted', pool, 'if (current !== item.stamp)', 'if (false)', spec),
    ('aliases treated as competing stores', pool, 'if (seen.has(identity)) continue', 'if (false) continue', spec),
    ('pool deadline ignored', pool, 'if (ms <= 0)', 'if (false)', spec),
    ('first hook home wins', hook, 'if (found.length !== 1)', 'if (false)', hook_spec),
    ('unavailable hook admitted', hook, "return { kind: 'hold', reason: `Hermes session source is unavailable; keeping the current conversation. ${error.message}` }", "return { kind: 'accept', value: undefined }", hook_spec),
    ('cached SQLite deadline ignored', 'src/lib/sqliteBuiltin.ts', 'if (cached.busyTimeoutMs !== timeout)', 'if (false)', 'src/lib/sqliteRead.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(env):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        env.pop(key, None)
Path(env['TMUX_TMPDIR']).mkdir(parents=True, exist_ok=True)


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=2'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run(list(dict.fromkeys(item[4] for item in mutations)))
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
