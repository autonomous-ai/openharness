#!/usr/bin/env python3
"""Compare a Git baseline and working-tree link matcher in one Dart process."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--flutter', required=True, type=Path)
parser.add_argument('--baseline', required=True)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--aot', action='store_true', help='Compile both matchers into one native Dart executable')
args = parser.parse_args()
desktop = Path(__file__).resolve().parents[1]
source = desktop / 'lib/terminal/terminal_links.dart'
output = args.output.resolve()
if output.exists():
    parser.error('Output already exists')
revision = subprocess.check_output(
    ['git', 'rev-parse', '--verify', f'{args.baseline}^{{commit}}'],
    cwd=desktop, text=True,
).strip()
baseline = subprocess.check_output(
    ['git', 'show', f'{revision}:desktop/lib/terminal/terminal_links.dart'],
    cwd=desktop,
)
candidate = source.read_bytes()
fixture = desktop / 'tool/terminal_links_benchmark.dart'
fixture_source = fixture.read_bytes()
with tempfile.TemporaryDirectory(prefix='harness-terminal-links-') as temp:
    root = Path(temp)
    # Only the import changes: core.dart exports the same terminal types,
    # without pulling Flutter UI into this headless benchmark executable.
    adapted_baseline = baseline.replace(
        b"import 'package:xterm/xterm.dart';",
        b"import 'package:xterm/core.dart';",
    )
    (root / 'before.dart').write_bytes(adapted_baseline)
    (root / 'comparison_test.dart').write_text(
        "import 'before.dart' as before;\n"
        f"import '{fixture.as_uri()}' as fixture;\n"
        'void main() => fixture.runLinkBenchmark(implementations: [\n'
        "  fixture.LinkImplementation('baseline', before.terminalLinkInText,\n"
        '    before.terminalLinkAt, before.terminalLinkSpans),\n'
        '  fixture.currentLinks,\n'
        ']);\n'
    )
    env = dict(os.environ, HARNESS_LINK_BENCH_OUTPUT=str(output))
    dart = str(args.flutter / 'bin/cache/dart-sdk/bin/dart')
    packages = str(desktop / '.dart_tool/package_config.json')
    if args.aot:
        executable = root / 'comparison'
        subprocess.run([
            dart, 'compile', 'exe', f'--packages={packages}',
            str(root / 'comparison_test.dart'), '-o', str(executable),
        ], cwd=desktop, check=True)
        command = [str(executable)]
    else:
        command = [dart, f'--packages={packages}', str(root / 'comparison_test.dart')]
    subprocess.run(command, cwd=desktop, env=env, check=True)
if source.read_bytes() != candidate:
    raise RuntimeError('Candidate source changed during the comparison')
if fixture.read_bytes() != fixture_source:
    raise RuntimeError('Benchmark source changed during the comparison')
result = json.loads(output.read_text())
result['boundary'] = f"headless Dart {'AOT' if args.aot else 'JIT'} synchronous hit-testing elapsed time"
result['source'] = {
    'baselineCommit': revision,
    'baselineSha256': hashlib.sha256(baseline).hexdigest(),
    'baselineImportAdaptation': 'xterm.dart umbrella export replaced with core.dart; no executable baseline code changes',
    'adaptedBaselineSha256': hashlib.sha256(adapted_baseline).hexdigest(),
    'candidateSha256': hashlib.sha256(candidate).hexdigest(),
    'fixtureSha256': hashlib.sha256(fixture_source).hexdigest(),
    'dependencies': 'Both implementations use current-worktree Flutter/xterm dependencies',
}
output.write_text(json.dumps(result, indent=2) + '\n')
