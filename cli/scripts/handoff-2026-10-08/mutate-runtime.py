"""Break runtime wiring in an isolated worktree; every break must fail a golden assertion."""
import os
from pathlib import Path
import re
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
reader = lambda engine: f'src/engines/{engine}/profileReader.ts'
owner = 'src/lib/runtimeProfileState.ts'
observations = 'src/engines/otherRuntime.golden.spec.ts'
state = 'src/lib/runtimeProfileState.golden.spec.ts'
# Label, source, former expression, broken expression, golden, selected test.
mutations = [
    ('pi footer ignored', reader('pi'), 'pi.parsePiFooterProfile(paneText)', 'null', observations, 'pi: every pane'),
    ('grok footer ignored', reader('grok'), 'grok.parseGrokFooterProfile(paneText)', 'null', observations, 'grok: every pane'),
    ('agy footer ignored', reader('agy'), 'agy.parseAgyFooterProfile(paneText)', 'null', observations, 'agy: every pane'),
    ('devin footer ignored', reader('devin'), 'devin.devinFooterModel(paneText)', 'null', observations, 'resolves OpenCode'),
    ('hermes status ignored', reader('hermes'), 'hermes.hermesStatusModel(paneText)', 'null', observations, 'hermes: every pane'),
    ('commandcode banner ignored', reader('commandcode'), 'commandcode.commandcodeBannerModel(paneText)', 'null', observations, 'commandcode: every pane'),
    ('opencode catalog disconnected', reader('opencode'), 'opencode.opencodeFooterModelId(paneText, this.opencodeCatalogCache?.entries ?? [])', 'opencode.opencodeFooterModelId(paneText, [])', observations, 'resolves OpenCode'),
    ('kilo catalog disconnected', reader('kilo'), 'kilo.kiloFooterModelId(paneText, this.kiloCatalogCache?.entries ?? [])', 'kilo.kiloFooterModelId(paneText, [])', observations, 'resolves OpenCode'),
    ('hermes effort discarded', reader('hermes'), "state.effort = parsed.effort ?? 'auto'", "state.effort = 'auto'", observations, 'reads each config'),
    ('muse settings ignored', reader('muse'), "muse.parseMuseSettings(await readText(join(env.MUSE_CONFIG_DIR, 'settings.json')))", "muse.parseMuseSettings('')", observations, 'reads each config'),
    ('amp session ignored', reader('amp'), "amp.parseAmpSession(await readText(join(env.AMP_STATE_DIR, 'session.json')))", "amp.parseAmpSession('')", observations, 'reads each config'),
    ('devin catalog ignored', reader('devin'), 'devin.parseDevinModelsOutput(result.stdout)', "devin.parseDevinModelsOutput('')", observations, 'resolves OpenCode'),
    ('cursor footer ignored', reader('cursor'), 'const parsed = footerLines.map(parseCursorFooter).find((item) => item !== null)', 'const parsed = null', observations, 'cursor: every pane'),
    ('confirmed model corrupted', owner, 'state.model = target.model', "state.model = 'wrong-model'", state, 'linux'),
    ('forgotten state retained', owner, 'this.states.delete(sessionId)', 'void sessionId', state, 'linux'),
    ('config contribution dropped', owner, 'Object.assign(state, context.state)', 'Object.assign(state, {})', observations, 'reads each config'),
]

env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for key in ['RECORD_OTHER_ENGINES_GOLDEN', 'RECORD_RUNTIME_STATE_GOLDEN', 'TMUX', 'TMUX_PANE']:
    env.pop(key, None)
logs = cli.parent / '.harness' / 'runtime-mutations'
logs.mkdir(parents=True, exist_ok=True)
failed = []
for index, (name, path, old, new, golden, pattern) in enumerate(mutations, 1):
    file = cli / path
    original = file.read_text()
    if original.count(old) != 1:
        raise RuntimeError(f'{name}: expected one source anchor, got {original.count(old)}')
    file.write_text(original.replace(old, new))
    try:
        run = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', golden, '-t', pattern, '--maxWorkers=1',
                              '--testTimeout=15000', '--hookTimeout=45000'],
                             cwd=cli, env=env, capture_output=True, text=True, timeout=150)
        output = run.stdout + run.stderr
        (logs / f'{index:02d}.log').write_text(output)
        caught = run.returncode != 0 and re.search(r'AssertionError|AssertionError:', output) is not None
        print(f'{name}: {"assertion caught" if caught else "NOT caught by an assertion"}', flush=True)
        if not caught:
            failed.append(name)
    finally:
        file.write_text(original)
if failed:
    raise SystemExit('Unproven mutations: ' + ', '.join(failed))
print(f'All {len(mutations)} wiring mutations failed golden assertions.', flush=True)
