# Flip one declared rule or call site at a time and check the admission golden fails.
import subprocess, sys, os
cli = sys.argv[1]
C = 'src/engines/hermes/contract.ts'
H = 'src/hookServer.ts'
D = 'src/lib/terminalAgentDiscovery.ts'
K = 'src/engines/kit/storeSource.ts'
M = [
 ('hook server: default home only', H, "const homes = await listStoreHomes(HERMES_HOMES, env.HERMES_HOME)", "const homes = [env.HERMES_HOME]"),
 ('hook server: every source interactive', H, "if (!isInteractiveSource(HERMES_SOURCE, source)) {", "if (false) {"),
 ('contract: tui not interactive', C, "interactive: ['', 'cli', 'tui'],", "interactive: ['', 'cli'],"),
 ('contract: no source not interactive', C, "interactive: ['', 'cli', 'tui'],", "interactive: ['cli', 'tui'],"),
 ('contract: another column', C, "column: 'source',", "column: 'cwd',"),
 ('contract: no profiles', C, "max: 64,", "max: 0,"),
 ('contract: another store', C, "store: hermesDbPath,", "store: (home) => join(home, 'state.sqlite'),"),
 ('contract: profiles folder', C, "profiles: 'profiles',", "profiles: 'profile',"),
 ('kit: unread row is no row', K, "if (!result.ok) return ''", "if (!result.ok) return null"),
 ('kit: absent row is a pane own', K, "if (result.rows.length === 0) return null", "if (result.rows.length === 0) return ''"),
 ('discovery: home not probed', D, "? await (await loadEngine('hermes'))?.probeHermesHome(agent.processIdentity, agent.engine)", "? null"),
 ('discovery: no probe when unreadable', D, "? await (await loadEngine('hermes'))?.probeHermesHome(agent.processIdentity, agent.engine)", "? await (await loadEngine('hermes'))?.probeHermesHome(agent.processIdentity, agent.engine) ?? null"),
]
for name, path, old, new in M:
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherAdmission.golden.spec.ts'], cwd=cli, capture_output=True, text=True, env={**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'})
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
