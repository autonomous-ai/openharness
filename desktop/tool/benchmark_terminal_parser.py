#!/usr/bin/env python3
"""Compare exact Git-baseline and working-tree xterm parsing in one Dart AOT VM."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
from urllib.parse import urljoin

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--flutter', required=True, type=Path)
parser.add_argument('--baseline', required=True)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
desktop = Path(__file__).resolve().parents[1]
output = args.output.resolve()
if output.exists():
    parser.error('Output already exists')
revision = subprocess.check_output(
    ['git', 'rev-parse', '--verify', f'{args.baseline}^{{commit}}'],
    cwd=desktop, text=True).strip()
archive = subprocess.check_output(
    ['git', 'archive', revision, 'desktop/third_party/xterm/lib'], cwd=desktop.parent)
fixture = desktop / 'tool/terminal_parser_benchmark.dart'


def sources():
    return {str(p.relative_to(desktop)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [fixture, Path(__file__).resolve(),
                      *sorted((desktop / 'third_party/xterm/lib').rglob('*.dart'))]}


before = sources()
with tempfile.TemporaryDirectory(prefix='harness-parser-') as directory:
    root = Path(directory)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(root, filter='data')
    baseline = root / 'desktop/third_party/xterm'
    # The separate package name lets the exact baseline and candidate coexist.
    # Rewrite import URIs only; parser/buffer executable code stays unchanged.
    for path in (baseline / 'lib').rglob('*.dart'):
        path.write_text(path.read_text().replace('package:xterm/', 'package:xterm_before/'))
    config_path = desktop / '.dart_tool/package_config.json'
    config = json.loads(config_path.read_text())
    for package in config['packages']:
        package['rootUri'] = urljoin(config_path.as_uri(), package['rootUri'])
    xterm = next(package for package in config['packages'] if package['name'] == 'xterm')
    config['packages'].append(dict(xterm, name='xterm_before', rootUri=baseline.as_uri() + '/'))
    packages = root / 'package_config.json'
    packages.write_text(json.dumps(config))
    driver = root / 'comparison.dart'
    driver.write_text(
        "import 'package:xterm_before/core.dart' as before;\n"
        f"import '{fixture.as_uri()}' as fixture;\n"
        'void main() => fixture.runParserBenchmark(() => fixture.ParserTarget(\n'
        '  before.Terminal(maxLines: 1000, reflowEnabled: false)..resize(120, 30)));\n')
    dart = args.flutter.resolve() / 'bin/cache/dart-sdk/bin/dart'
    executable = root / 'comparison'
    subprocess.run([str(dart), 'compile', 'exe', f'--packages={packages}', str(driver),
                    '-o', str(executable)], cwd=desktop, check=True, timeout=120)
    subprocess.run([str(executable)], cwd=desktop, check=True, timeout=120,
                   env=dict(os.environ, HARNESS_PARSER_BENCH_OUTPUT=str(output)))
if sources() != before:
    raise RuntimeError('Benchmark inputs changed during measurement')
result = json.loads(output.read_text())
result.update({
    'boundary': 'Dart AOT synchronous ANSI parsing only; excludes rendering, transport, daemon and battery',
    'baselineCommit': revision,
    'baselineArchiveSha256': hashlib.sha256(archive).hexdigest(),
    'candidateAndFixtureSources': before,
    'baselineAdaptation': 'package:xterm/ import URIs renamed to package:xterm_before/ only',
})
output.write_text(json.dumps(result, indent=2) + '\n')
print(output)
