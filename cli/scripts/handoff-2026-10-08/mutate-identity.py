# Flip one lazy call site or declared layout at a time and check the identity golden fails.
import subprocess, sys, os
cli = sys.argv[1]
B = 'src/core/agents/bind.ts'
R = 'src/lib/sessionRepair.ts'
M = [
 ('bind: cursor finder ignored', B, "return cursor && cursor.findCursorTranscript(cursor.cursorDataDir(), sessionId)", "return null"),
 ('bind: grok cwd lost', B, "return grok && grok.findGrokTranscript(homes.grok, cwd, sessionId)", "return grok && grok.findGrokTranscript(homes.grok, '/', sessionId)"),
 ('bind: agy finder ignored', B, "return agy && agy.findAgyTranscript(homes.agy, sessionId)", "return null"),
 ('bind: copilot finder ignored', B, "return copilot && copilot.findCopilotTranscript(homes.copilot, sessionId)", "return null"),
 ('bind: copilot /resume not followed', B, "const current = await copilot.copilotSessionForPid(homes.copilot, observed.processIdentity.pid)", "const current = null as string | null"),
 ('repair: muse run ignored', R, "if (!hasRun(lines, muse.museEvent)) return null", ""),
 ('repair: muse workspace lost', R, "const root = muse.museWorkspaceRoot(lines[0] ?? '')", "const root = null as string | null"),
 ('repair: hermes default home only', R, "const homes = await listStoreHomes(HERMES_HOMES, env.HERMES_HOME)", "const homes = [env.HERMES_HOME]"),
 ('repair: copilot lock ignored', R, "const locked = opts?.pid ? await copilot.copilotSessionForPid(env.COPILOT_HOME, opts.pid) : null", "const locked = null as string | null"),
 ('repair: copilot cwd lost', R, "return copilotDirectoryScan(cwd, startedAtMs, opts, copilot.copilotSessionCwd)", "return copilotDirectoryScan(cwd, startedAtMs, opts, () => null)"),
 ('repair: agy pid ignored', R, "return opts?.pid ? agySession(opts.pid) : null", "return null"),
 ('repair: agy transcript lost', R, "const transcriptPath = await agy.findAgyTranscript(env.AGY_HOME, conversationId)", "const transcriptPath = null as string | null"),
 ('repair: pi folder wrong', R, "const directory = join(env.PI_HOME, 'agent', 'sessions', piSessionFolder(opts.cwd))", "const directory = join(env.PI_HOME, 'agent', 'sessions', piSessionFolder('/'))"),
 ('contract: agy layout', 'src/engines/agy/contract.ts', "'transcript_full.jsonl')", "'transcript.jsonl')"),
 ('contract: copilot layout', 'src/engines/copilot/contract.ts', "join(copilotHome, 'session-state', sessionId, 'events.jsonl')", "join(copilotHome, 'session-state', sessionId + '.jsonl')"),
 ('contract: commandcode slug', 'src/engines/commandcode/contract.ts', "return slugify(cwd) || 'root'", "return slugify(cwd, { decamelize: false }) || 'root'"),
 ('contract: cursor data dir env ignored', 'src/engines/cursor/contract.ts', "return vars.CURSOR_DATA_DIR?.trim() || env.CURSOR_HOME", "return env.CURSOR_HOME"),
 ('contract: cursor config XDG ignored', 'src/engines/cursor/contract.ts', "(vars.XDG_CONFIG_HOME?.trim() ? join(vars.XDG_CONFIG_HOME.trim(), 'cursor') : env.CURSOR_HOME)", "env.CURSOR_HOME"),
 ('contract: hermes store name', 'src/engines/hermes/contract.ts', "return join(home, 'state.db')", "return join(home, 'state.sqlite')"),
 ('contract: hermes ids narrowed', 'src/engines/hermes/contract.ts', "|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/", ")$/"),
]
for name, path, old, new in M:
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherIdentity.golden.spec.ts'], cwd=cli, capture_output=True, text=True, env={**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'})
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
