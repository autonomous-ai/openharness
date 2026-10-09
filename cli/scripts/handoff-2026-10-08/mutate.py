# Flip one engine's branch at a time and check the golden fails. Usage: python3 mutate.py <cli dir>
import subprocess, sys, os
cli = sys.argv[1]
M = [
 ('opencode', 'src/lib/questionPane.ts', "  if (engine === 'opencode') {", "  if (engine === 'opencode' && false) {"),
 ('cursor', 'src/lib/questionPane.ts', "if (engine === 'cursor') return", "if (engine === 'cursor' && false) return"),
 ('kilo', 'src/lib/questionPane.ts', "if (engine === 'kilo') return", "if (engine === 'kilo' && false) return"),
 ('devin', 'src/lib/questionPane.ts', "if (engine === 'devin') return", "if (engine === 'devin' && false) return"),
 ('hermes', 'src/lib/questionPane.ts', "if (engine === 'hermes') return", "if (engine === 'hermes' && false) return"),
 ('amp', 'src/lib/questionPane.ts', "if (engine === 'amp') return", "if (engine === 'amp' && false) return"),
 ('agy', 'src/lib/questionPane.ts', "if (engine === 'agy') return", "if (engine === 'agy' && false) return"),
 ('grok', 'src/lib/questionPane.ts', "if (engine === 'grok') return", "if (engine === 'grok' && false) return"),
 ('copilot', 'src/lib/questionPane.ts', "  if (engine === 'copilot') {", "  if (engine === 'copilot' && false) {"),
 ('muse', 'src/lib/questionPane.ts', "if (engine === 'muse') return", "if (engine === 'muse' && false) return"),
 ('commandcode (into hermes\'s unframing)', 'src/lib/questionPane.ts', "if (engine === 'hermes') return", "if (engine === 'hermes' || engine === 'commandcode') return"),
 ('pi (pane)', 'src/lib/legacyPane.ts', "engine === 'pi' ? inspectPiPane(capture)", "engine === 'pi' && false ? inspectPiPane(capture)"),
 ('pi (into agy\'s dialog reader)', 'src/lib/questionPane.ts', "if (engine === 'agy') return", "if (engine === 'agy' || engine === 'pi') return"),
 ('terminal', 'src/engines/kit/screen.ts', "parseQuestionPane(capture))\n}", "null)\n}"),
 ('amp walk', 'src/engines/amp/contract.ts', "questionWalk: 'down'", "questionWalk: 'right'"),
 ('kilo walk', 'src/engines/kilo/contract.ts', "questionWalk: 'right'", "questionWalk: 'down'"),
 ('opencode walk (row walk ignored)', 'src/lib/questionController.ts', "const walk = WALKS[engine] ?? row.walk", "const walk = WALKS[engine]"),
 ('devin multi-select submit', 'src/lib/questionController.ts', "return engine === 'devin' ? 'Enter' : 'Tab'", "return 'Tab'"),
]
for name, path, old, new in M:
    p = os.path.join(cli, path)
    s = open(p).read()
    assert s.count(old) == 1, (name, s.count(old))
    open(p, 'w').write(s.replace(old, new))
    try:
        r = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', 'src/engines/otherScreens.golden.spec.ts'], cwd=cli, capture_output=True, text=True)
        print(f"{name:45s} {'FAILS (caught)' if r.returncode else 'PASSES (NOT caught)'}", flush=True)
    finally:
        open(p, 'w').write(s)
