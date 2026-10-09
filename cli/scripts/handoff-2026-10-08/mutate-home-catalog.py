"""Run in an owned disposable worktree; every deliberately broken boundary must assertion-fail."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
kit = 'src/engines/kit/homeCatalog.ts'
homes = 'src/lib/engineHomes.ts'
spec = 'src/engines/kit/homeCatalog.spec.ts'
golden = 'src/lib/engineHomes.golden.spec.ts'
mutations = [
    ('identity uses legacy roots', 'src/lib/sessionRepair.ts', "import { nativeSessionRoots }", "import { sessionRoots as nativeSessionRoots }", spec),
    ('moved roots disconnected', homes, '...read.homes[engine as SessionStoreEngine].map(home => join(home, moved.folder))', '...[]', golden),
    ('known competing homes ignored', homes, 'if (nativeKnownHomes[name].some(home => !read.homes[name].includes(home)))', 'if (false)', spec),
    ('unsaved adoption ignored', homes, 'const legacy = movedByEngine[name]', 'const legacy: string[] = []', spec),
    ('previous fresh homes forgotten', homes, 'const names = Object.keys(sessionStoreContracts)', 'nativeKnownHomes = { claude: [], codex: [] }; const names = Object.keys(sessionStoreContracts)', spec),
    ('held-read positive facts forgotten', homes, 'nativeKnownHomes[name].push(home)', "if (!nativeKnownHomes[name].some(known => !read.homes[name].includes(known))) nativeKnownHomes[name].push(home)", spec),
    ('legacy list bound removed', homes, 'if (legacy.length > MAX_CATALOG_HOMES)', 'if (false)', spec),
    ('cumulative home bound removed', homes, 'if (nativeKnownHomes[name].length === MAX_CATALOG_HOMES)', 'if (false)', spec),
    ('overflow fact forgotten', homes, 'if (nativeCatalogOverflow) overflow()', 'if (false) overflow()', spec),
    ('byte bound removed', kit, 'if (info.size > MAX_BYTES)', 'if (false)', spec),
    ('root bound removed', kit, 'if (homes.length > MAX_CATALOG_HOMES)', 'if (false)', spec),
    ('read-operation bound removed', kit, 'if (++calls > 64)', 'if (false)', spec),
    ('read deadline removed', kit, 'if (performance.now() - started > 250)', 'if (false)', spec),
    ('path replacement fence removed', kit, 'stamp(lstatSync(file)) !== stamp(before)', 'false', spec),
    ('write permission ignored', kit, '|| (info.mode & 0o022)', '|| false', spec),
    ('malformed home list omitted', kit, "if (!Array.isArray(homes)) throw unavailable('has an invalid home list')", 'if (!Array.isArray(homes)) continue', spec),
    ('duplicate home lists accepted', kit, 'if (keys.has(key))', 'if (false)', spec),
    ('invalid UTF-8 replaced silently', kit, "new TextDecoder('utf-8', { fatal: true })", "new TextDecoder('utf-8')", spec),
    ('dangling catalog parent treated as empty', kit, 'return absent(file, deadline)', "return { homes: { claude: [], codex: [] }, text: null, version: null }", spec),
    ('catalog loses typed hold', kit, 'new IdentityReadUnavailable(`the saved engine-home catalog ${reason}`)', 'new Error(`the saved engine-home catalog ${reason}`)', spec),
    ('exact lookup final roots not checked', 'src/lib/sessionRepair.ts', "if (repairRoots(engine, opts?.codexHome).join('\\0') !== roots.join('\\0'))", 'if (false)', spec),
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


baseline = run([spec, golden])
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
