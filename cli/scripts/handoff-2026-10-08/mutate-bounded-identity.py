"""Break actual native-identity wiring in a disposable worktree; assertions must catch every change."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
bounds = 'src/lib/sessionRepair.bounds.spec.ts'
repair = 'src/lib/sessionRepair.ts'
scan = 'src/engines/kit/identityScan.ts'
golden = 'src/engines/repairIdentity.golden.spec.ts'
close = 'src/lib/closeAgentService.spec.ts'
mutations = [
    ('truncated file pool', repair, "if (out.length >= MAX_FILES) throw new IdentityReadUnavailable('the transcript count limit was reached')", 'if (out.length >= MAX_FILES) continue', bounds),
    ('truncated depth', repair, "if (depth >= MAX_DEPTH) throw new IdentityReadUnavailable('the transcript depth limit was reached')", 'if (depth >= MAX_DEPTH) continue', bounds),
    ('directory buffer bound', scan, 'for await (const entry of directory) {\n      if (budget.remaining-- <= 0)', 'for await (const entry of directory) {\n      if (budget.remaining-- < -1)', bounds),
    ('unreadable tree treated as absent', scan, "if (missingOkay && (error as NodeJS.ErrnoException).code === 'ENOENT') return", 'return', bounds),
    ('partial header treated as absent', repair, 'if (!cwd || (sidechain && side === undefined && malformed))', 'if (false)', bounds),
    ('permissive Codex reader', repair, 'findSessionFileOf, sessionIdentityMetaOf }', 'findSessionFileOf, sessionMetaOf as sessionIdentityMetaOf }', bounds),
    ('Copilot missing identity ignored', repair, 'if (!root || !isAbsolute(root)) throw new IdentityReadUnavailable(head.complete', 'if (false) throw new IdentityReadUnavailable(head.complete', bounds),
    ('invalid process start accepted', repair, "|| !Number.isFinite(Date.parse(record[rule.start]))", '', bounds),
    ('first home wins', repair, '    result = found\n', '    return found\n', bounds),
    ('authoritative claim read too early', repair, 'const recheck = [...records.filter(record => record.file !== selected), ...records.filter(record => record.file === selected)]', 'const recheck = records', bounds),
    ('home adoption ignored during lookup', repair, "if (repairRoots(engine, opts?.codexHome).join('\\0') !== sessions.join('\\0'))", 'if (false)', bounds),
    ('unbounded known homes', repair, 'if (roots.length > 64)', 'if (false)', bounds),
    ('process claim not rechecked', repair, 'if (await read(file) !== text)', 'if (false)', bounds),
    ('replaced inode accepted', scan, 'const now = await current.stat()', 'const now = before', bounds),
    ('whole-file byte limit ignored', scan, 'if (bytes.length > maxBytes)', 'if (false)', bounds),
    ('Close hold becomes failed', 'src/lib/closeAgentService.ts', "state: result.error === 'IDENTITY_UNAVAILABLE' ? 'waiting' : 'failed'", "state: 'failed'", close),
    ('Muse declaration disconnected', 'src/engines/muse/contract.ts', "'workspace_root'", "'missing_workspace'", golden),
    ('Pi native header disconnected', repair, 'const head = await readPiHead(join(directory, file))', 'const head = null', golden),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for name in ['TMUX', 'TMUX_PANE', 'RECORD_REPAIR_IDENTITY_GOLDEN',
             'RECORD_OTHER_ENGINES_GOLDEN', 'RECORD_SESSION_STORE_GOLDEN']:
    env.pop(name, None)


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=2'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run(list(dict.fromkeys(item[4] for item in mutations)))
if baseline.returncode:
    print(baseline.stdout + baseline.stderr)
    raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, spec in mutations:
    path = cli / relative
    original = path.read_text()
    assert original.count(before) == 1, (label, original.count(before))
    try:
        path.write_text(original.replace(before, after))
        result = run([spec])
        output = result.stdout + result.stderr
        if result.returncode == 0 or 'AssertionError' not in output:
            print(output)
            raise SystemExit(f'{label}: not caught by an assertion')
        print(f'{label}: caught by assertion', flush=True)
    finally:
        path.write_text(original)
