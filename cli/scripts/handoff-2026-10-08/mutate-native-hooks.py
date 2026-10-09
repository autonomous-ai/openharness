"""Break native hook declarations and core wiring. Only assertion failures count as kills."""
import os
from pathlib import Path
import subprocess
import sys

cli = Path(sys.argv[1]).resolve()
golden = 'src/engines/otherHooks.golden.spec.ts'
architecture = 'src/architecture.spec.ts'
wiring = 'src/core/engines/hooks.spec.ts'
mutations = [
    ('wrong JSON event', 'src/engines/cursor/contract.ts', '"beforeSubmitPrompt"', '"afterSubmitPrompt"', golden),
    ('fail-closed notification', 'src/engines/cursor/contract.ts', '"failClosed": false', '"failClosed": true', golden),
    ('foreign JSON removed', 'src/engines/kit/nativeHookSettings.ts', 'blocks.filter(block => !isOurs(block))', 'blocks.filter(() => false)', golden),
    ('wrong plugin port', 'src/engines/nativeHooks.ts', 'port: String(port)', "port: '19475'", golden),
    ('wrong OpenCode generation', 'src/engines/nativeHooks.ts', 'opencodeMajorVersion() === 1', '(opencodeMajorVersion() ?? 0) >= 1', golden),
    ('legacy plugin removal lost', 'src/engines/opencode/contract.ts', "contains: 'export const MachineRegister ='", "contains: 'export const NotOurPlugin ='", golden),
    ('foreign YAML overwritten', 'src/engines/kit/nativeHookYaml.ts', 'if (foreignHooks)', 'if (false)', golden),
    ('profile config missed', 'src/engines/hermes/contract.ts', "directory: 'profiles', file: 'config.yaml'", "directory: 'profiles', file: 'not-config.yaml'", golden),
    ('approval event omitted', 'src/engines/kit/nativeHookYaml.ts', 'for (const event of rule.events) {', 'for (const event of rule.events.slice(1)) {', golden),
    ('wrong installer wired', 'src/core/engines/hooks.ts', "['kilo', nativeHooks.installKiloPlugin]", "['kilo', port => nativeHooks.installKiloPlugin(port + 1)]", golden),
    ('pre-spawn installation skipped', 'src/core/engines/hooks.ts', '  nativeHooks.installOpencodePlugin(port)', '  void port', wiring),
    ('lazy startup restored', 'src/core/engines/hooks.ts', '  for (const [vendor, install] of OTHER_INSTALLERS)', "  await (await import('../../engines/inProcess.js')).loadEngine('hooks')\n  for (const [vendor, install] of OTHER_INSTALLERS)", architecture),
]
env = {**os.environ, 'TZ': 'UTC', 'TMPDIR': '/tmp'}
for name in ['TMUX', 'TMUX_PANE', 'RECORD_OTHER_ENGINES_GOLDEN']:
    env.pop(name, None)


def run(specs):
    return subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', *specs, '--maxWorkers=1'],
                          cwd=cli, env=env, capture_output=True, text=True, timeout=180)


baseline = run([golden, architecture, wiring])
if baseline.returncode:
    print(baseline.stdout + baseline.stderr)
    raise SystemExit('baseline failed; no mutants ran')
print('unchanged baseline passed', flush=True)
for label, relative, before, after, spec in mutations[int(os.environ.get('MUTATION_START', '0')):]:
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
