"""Owned disposable worktree only: adoption and hook retries must fail assertions when disconnected."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
writer = 'src/engines/kit/homeAdoption.ts'
homes = 'src/lib/engineHomes.ts'
coordinator = 'src/core/engines/homeAdoptions.ts'
spec = 'src/engines/kit/homeAdoption.spec.ts'
home_spec = 'src/lib/engineHomes.spec.ts'
coord_spec = 'src/core/engines/homeAdoptions.spec.ts'
mutations = [
    ('durable writer disconnected', homes, 'const committed = writer.adopt(', 'const committed = ((..._args: unknown[]) => ({ claude: [], codex: [] }))(', 'src/lib/engineHomeAdoption.golden.spec.ts'),
    ('new record never confirmed', writer, 'seal({ path, value, digest: digest(text), sealed: false }, found.entries.length, found, staging, check)', 'void 0', spec),
    ('stage flush omitted', writer, 'writeFileSync(fd, text); fsyncSync(fd); check()', 'writeFileSync(fd, text); check()', spec),
    ('directory flush omitted', writer, '    fsyncSync(fd); check()', '    check()', spec),
    ('final baseline import omitted', writer, 'if (ENGINES.some(engine => observed[engine].some(home => !recorded[engine].includes(home)))\n          || (legacyObserved && !final.entries.at(-1)?.value.legacyRequired)) return null', 'if (false) return null', spec),
    ('requested unsaved home forgotten', homes, '...(pendingCatalogFile === file ? [pendingHomes[name]] : [])', '...[]', home_spec),
    ('empty boot skips published recovery', writer, '      merge(additions)', '      if (!additions.claude.length && !additions.codex.length) return readAdoptedHomes(file).homes\n      merge(additions)', spec),
    ('last frontier omitted', writer, '  frontier()\n  check()', '  check()', spec),
    ('numbered membership omitted', writer, 'if (present !== result.includes(name))', 'if (false)', spec),
    ('directory stamp omitted', writer, 'if (stamp(after) !== stamp(info))', 'if (false)', spec),
    ('required legacy file ignored', writer, "if (required && legacy.text === null)", 'if (false)', spec),
    ('held observations forgotten across calls', writer, '    const check = deadline()\n    try {', '    observed = empty(); legacyObserved = false; exhausted = false\n    const check = deadline()\n    try {', spec),
    ('recovery uses a fresh adopter', homes, 'return adopter().adopt({ claude: [], codex: [] })', 'return createHomeAdopter(savedFile()).adopt({ claude: [], codex: [] })', home_spec),
    ('held observations cannot constrain roots', homes, '...(observed ? [observed.homes[name]] : [])', '...[]', home_spec),
    ('peer recovery hooks forgotten', coordinator, 'restoring = true // Confirmation may also have recovered another writer\'s home.', 'restoring = false', coord_spec),
    ('closed callback accepted', coordinator, 'closed = true', 'closed = false', coord_spec),
    ('batch final proof omitted', 'src/lib/registry.ts', 'try { snapshot.verify() }', 'try { void 0 }', 'src/lib/registry.homes.spec.ts'),
    ('batch preservation omitted', 'src/lib/registry.ts', 'for (const [id, raw] of dependent) preserve(staged.get(id)!, raw, error)', 'void 0', 'src/lib/registry.homes.spec.ts'),
    ('boot recovery disconnected', 'src/core/engines/hooks.ts', 'read: recoverEngineHomes,', 'read: () => ({ claude: [], codex: [] }),', 'src/core/engines/hooks.spec.ts'),
    ('released binding retains hold', 'src/lib/registry.ts', '    delete entry.identityHold', '    void 0', 'src/lib/registry.homes.spec.ts'),
    ('stopped snapshot persists hold', 'src/lib/stoppedAgents.ts', '    delete snapshot.identityHold', '    void 0', 'src/lib/stoppedAgents.spec.ts'),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in list(env):
    if key in ['TMUX', 'TMUX_PANE'] or key.startswith('RECORD_'):
        env.pop(key)
if not Path(env.get('TMUX_TMPDIR', '/missing-private-tmux')).is_dir():
    raise SystemExit('An existing private TMUX_TMPDIR is required')


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run(sorted({target for _, _, _, _, target in mutations}))
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
