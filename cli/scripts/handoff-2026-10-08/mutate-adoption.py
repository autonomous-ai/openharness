# Flip one piece of the adoption wiring at a time and check the adoption golden fails.
import subprocess, sys, os
cli = sys.argv[1]
I = 'src/lib/sessionSearch/externals/index.ts'
M = [
 ('owners never asked', I, "owners: async (view) => await (await reader())?.owners?.(view) ?? [],", "owners: async () => [],"),
 ('busy never answered', I, "busy: async (owner) => await (await reader())?.busy?.(owner) ?? null,", "busy: async () => null,"),
 ('a new reader per call', I, "provider ??= loadEngine(name)", "provider = loadEngine(name)"),
 ('kilo reads opencode store', I, "code.opencodeProvider({ engine: 'kilo', dbPath: paths.kiloDb })", "code.opencodeProvider({ engine: 'kilo', dbPath: paths.opencodeDb })"),
 ('pi loses its moved folder', I, "...(paths.piSessionDir ? { sessionDir: paths.piSessionDir } : {})", ""),
 ('cursor without its data folder', I, "dataDir: paths.cursorDataDir }", "dataDir: paths.cursorConfigDir }"),
 ('grok as muse', I, "loaded('grok', 'grok',", "loaded('grok', 'muse',"),
 ('devin unloaded', I, "loaded('devin', 'devin', (code) => code.devinProvider({ home: paths.devinHome })),", ""),
 ('agy unloaded', I, "loaded('agy', 'agy', (code) => code.agyProvider({ home: paths.agyHome })),", ""),
]
for name, path, old, new in M:
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherAdoption.golden.spec.ts'], cwd=cli, capture_output=True, text=True, env={**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'})
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
