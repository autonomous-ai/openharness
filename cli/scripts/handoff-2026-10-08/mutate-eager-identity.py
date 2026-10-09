"""Break one eager location wire at a time. Only assertion failures count, never setup or timeouts."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/otherIdentity.golden.spec.ts'
bind = 'src/core/agents/bind.spec.ts'
discovery = 'src/engines/kit/transcriptDiscovery.spec.ts'
profile = 'src/lib/terminalAgentDiscovery.hermesHome.spec.ts'
attach = 'src/core/transcripts/attach.spec.ts'
mutations = [
    ('Cursor layout lost', 'src/engines/cursor/contract.ts', "root: 'projects'", "root: 'wrong-projects'", golden),
    ('Grok hashed cwd lost', 'src/engines/grok/contract.ts', "sidecar: '.cwd'", "sidecar: '.wrong-cwd'", golden),
    ('Agy transcript lost', 'src/engines/agy/contract.ts', "file: ['.system_generated', 'logs', 'transcript_full.jsonl']", "file: ['.system_generated', 'logs', 'wrong.jsonl']", golden),
    ('Copilot resume lock lost', 'src/engines/copilot/contract.ts', "prefix: 'inuse.'", "prefix: 'wrong.'", golden),
    ('binding bypasses native transcript', 'src/core/agents/bind.ts', "transcriptOf(engine, engine === 'cursor' ? cursorDataDir() : homes[engine], sessionId, cwd)", "Promise.resolve(null)", golden),
    ('removed lookup publishes', 'src/engines/kit/transcriptDiscovery.ts', "if (this.pending.get(id) !== candidate) return", "if (false) return", discovery),
    ('old sweep publishes', 'src/engines/kit/transcriptDiscovery.ts', "if (!found || this.pending.get(id) !== candidate) continue", "if (!found) continue", discovery),
    ('profile fact lost', 'src/engines/hermes/contract.ts', "variable: 'HERMES_HOME'", "variable: 'UNDECLARED_HOME'", profile),
    ('SQLite binding unavailable', 'src/lib/sqliteRead.ts', 'const Database = builtinSqlite()', "return { ok: false, reason: 'transient' }; const Database = builtinSqlite()", golden),
    ('changed binding fence lost', 'src/core/agents/bind.ts', 'paneReadIdentity(registry.byProcess(observed.engine, observed.processIdentity)) === authority', 'true', bind),
    ('binding publication waits on reader', 'src/core/agents/bind.ts', '      stoppedAgents.save(entry)', '      await attachSession(entry); stoppedAgents.save(entry)', bind),
    ('target claim not rechecked', 'src/core/agents/bind.ts', 'if (!current() || !mayClaim(sessionId)) return', 'if (!current()) return', bind),
    ('changed path joins obsolete reader', 'src/lib/attachTracker.ts', 'if (!reset && pending.identity === identity)', 'if (!reset)', attach),
    ('newer reader keeps obsolete retry', 'src/core/transcripts/readerLoads.ts', '      held.delete(sessionId)\n      let loading', '      // broken: old retry retained\n      let loading', attach),
    ('missing reader starts a tail', 'src/core/transcripts/attach.ts', 'its reader is unavailable or still loading`)\n      return true', 'its reader is unavailable or still loading`)\n      // broken: interpretation proceeds', attach),
    ('binding waits on optional attachment', 'src/core/agents/bind.ts', 'followRegistered(result.entry, result)', 'await handleRegistered(result.entry, result)', bind),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
env.pop('TMUX', None)
env.pop('TMUX_PANE', None)
env.pop('RECORD_OTHER_ENGINES_GOLDEN', None)

def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=2'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)

baseline = run([golden, bind, discovery, profile, attach])
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
