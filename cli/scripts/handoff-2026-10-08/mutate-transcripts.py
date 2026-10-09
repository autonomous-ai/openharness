# Flip one engine's transcript handling at a time and check the transcripts golden fails.
import subprocess, sys, os
cli = sys.argv[1]
I, A, H, L = 'src/core/transcripts/ingest.ts', 'src/core/transcripts/attach.ts', 'src/core/transcripts/history.ts', 'src/core/transcripts/lastTurn.ts'
ONLY = sys.argv[2:] 
M = [
 ('ingest: muse lines through pi', I, "normalizer = new muse.MuseNormalizer()", "normalizer = new (engineNow('pi', 'x')!).PiNormalizer('live') as never"),
 ('ingest: commandcode run error unannounced', I, "const runError = commandcode?.commandCodeRunError(evt.text) ?? null", "const runError = null as string | null"),
 ('attach: agy idle close skipped', A, "if (historyTurnOpen && capture && agy.agyPaneIdle(capture)) {", "if (false) {"),
 ('attach: copilot history-open check skipped', A, "if (historyTurnOpen && !copilot.copilotHistoryTurnOpen(lines)) {", "if (false) {"),
 ('attach: cursor normalizer in history mode', A, ".CursorNormalizer('live', session.sessionId)", ".CursorNormalizer('history' as never, session.sessionId)"),
 ('attach: pi in replay mode', A, "PiNormalizer('live')", "PiNormalizer('replay' as never)"),
 ('history: grok replays as raw lines', H, "wholeHistoryPage(engine('grok').grokMessagesToEvents(lines), false).events", "wholeHistoryPage(messagesToEvents(lines), false).events"),
 ('history: pi window as commandcode', H, "? engine('pi').windowPiLines(lines, { limit, before })", "? (engine('commandcode' as never) as never as { windowCommandCodeLines: typeof windowRawLines }).windowCommandCodeLines(lines, { limit, before })"),
 ('history: amp export ignored', H, "const messages = await amp.readAmpThread(sessionId)", "const messages = null as Awaited<ReturnType<typeof amp.readAmpThread>>"),
 ('history: devin window', H, "m.devinMessagesToEvents, m.windowDevinMessages", "m.devinMessagesToEvents, ((rows: never[], o: { limit: number }) => ({ window: rows.slice(-o.limit), hasMore: false, oldestCursor: null })) as never"),
 ('last turn: hermes via kilo text', L, "return m ? m.lastHermesTurnText(", "return m ? (m as never as { lastHermesTurnText: (rows: never) => null }).lastHermesTurnText(null as never) ?? m.lastHermesTurnText("),
 ('last turn: muse', L, "lastMuseTurnText(lines) ?? null", "lastMuseTurnText([]) ?? null"),
]
for name, path, old, new in M:
    if ONLY and not any(o in name for o in ONLY): continue
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherTranscripts.golden.spec.ts'], cwd=cli, capture_output=True, text=True)
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
