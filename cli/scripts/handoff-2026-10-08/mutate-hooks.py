# Flip one installer's behavior at a time and check the hooks golden fails. Usage: python3 mutate-hooks.py <cli dir>
import subprocess, sys, os
cli = sys.argv[1]
H = 'src/lib/hooks.ts'
M = [
 ('grok: StopFailure dropped', H, "'UserPromptSubmit', 'StopFailure'] as const", "'UserPromptSubmit'] as const"),
 ('agy: handler timeout', H, "--agy-event ${event}`, timeout: 10 })", "--agy-event ${event}`, timeout: 11 })"),
 ('copilot: sessionEnd dropped', H, "      sessionEnd: [handler('sessionEnd')],\n", ""),
 ('cursor: failClosed', H, "const canonical: CursorHook = { command: cmd, failClosed: false }", "const canonical: CursorHook = { command: cmd, failClosed: true }"),
 ('kilo: product name', H, "const product = engine === 'kilo' ? 'Kilo' : 'OpenCode'", "const product = engine === 'kilo' ? 'kilo' : 'OpenCode'"),
 ('commandcode: PreToolUse dropped', H, "const COMMANDCODE_EVENTS = ['SessionStart', 'PreToolUse', 'Stop'] as const", "const COMMANDCODE_EVENTS = ['SessionStart', 'Stop'] as const"),
 ('devin: SessionEnd dropped', H, "const DEVIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd'] as const", "const DEVIN_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop'] as const"),
 ('hermes: block timeout', H, "\\n      timeout: 10`)", "\\n      timeout: 5`)"),
 ('pi: turn_end handler', H, 'pi.on("turn_end", async (_event, ctx) => { await register(ctx); });', ''),
 ('amp: sessions folder mode', H, "mkdirSync(env.AMP_SESSIONS_DIR, { recursive: true, mode: 0o700 })", "mkdirSync(env.AMP_SESSIONS_DIR, { recursive: true, mode: 0o755 })"),
 ('opencode: version gate', H, "if (opencodeMajorVersion() === 1) {", "if ((opencodeMajorVersion() ?? 0) >= 1) {"),
 ('loader mapping: kilo runs OpenCode\'s', 'src/core/engines/hooks.ts', "['kilo', (installers) => installers.installKiloPlugin],", "['kilo', (installers) => installers.installOpencodePlugin],"),
]
for name, path, old, new in M:
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherHooks.golden.spec.ts'], cwd=cli, capture_output=True, text=True)
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
