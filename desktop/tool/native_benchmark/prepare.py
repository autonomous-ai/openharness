#!/usr/bin/env python3
"""Build an isolated Release benchmark; never rewrite the user's V2 bundle."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from isolation import benchmark_configuration, validate_benchmark_bundle

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--flutter', required=True, type=Path)
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--interactive', action='store_true',
                    help='Build a disposable app for manual feature checks through normal input')
mode.add_argument('--flutter-dispatch', action='store_true',
                    help='Benchmark Flutter key dispatch and release raster, excluding OS input delivery')
mode.add_argument('--primary-workflows', action='store_true',
                    help='Benchmark Cmd+N/O/T and tab switching with varied input phase')
mode.add_argument('--core-workflows', action='store_true',
                    help='Validate and measure typing, navigation, search, and scrolling at idle and under output')
parser.add_argument('--terminals', type=int, choices=[1, 16, 48], default=16)
parser.add_argument('--samples', type=int, default=120)
parser.add_argument('--hold', action='store_true', help='Keep core fixture open after measurements for process resource sampling')
args = parser.parse_args()
if not 1 <= args.samples <= 500:
    parser.error('--samples must be 1–500')
if args.hold and not args.core_workflows:
    parser.error('--hold requires --core-workflows')
source = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='harness-native-benchmark-', dir='/private/tmp'))
desktop = root / 'desktop'
shutil.copytree(source, desktop, ignore=shutil.ignore_patterns('build', '.dart_tool', 'ephemeral', '.DS_Store'))
window = desktop / 'macos/Runner/MainFlutterWindow.swift'
code = window.read_text()
marker = '    super.awakeFromNib()'
if code.count(marker) != 1:
    raise RuntimeError('Native benchmark insertion point changed')
code = code.replace(marker, '    NativeBenchmark.install(window: self, messenger: flutterViewController.engine.binaryMessenger)\n' + marker)
if args.interactive or args.flutter_dispatch or args.primary_workflows or args.core_workflows:
    # Only this copied host gets fixture state. Launching through normal app
    # controls needs no shell environment and never opens a real transport.
    setup = '\n'.join(f'    setenv("{key}", "{value}", 1)' for key, value in {
        'FLUTTER_TEST': '1',
        'HARNESS_NATIVE_BENCHMARK': '1',
        'HARNESS_BENCH_MANUAL': '1' if args.interactive else '0',
        'HARNESS_BENCH_FLUTTER': '1' if args.flutter_dispatch or args.primary_workflows else '0',
        'HARNESS_BENCH_PRIMARY': '1' if args.primary_workflows else '0',
        'HARNESS_BENCH_CORE': '1' if args.core_workflows else '0',
        'HARNESS_BENCH_TERMINALS': str(args.terminals),
        'HARNESS_BENCH_SAMPLES': str(args.samples),
        'HARNESS_BENCH_HOLD': '1' if args.hold else '0',
        'HARNESS_BENCH_REVISION': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
        'HARNESS_BENCH_OUTPUT': str(root / 'interactive.json'),
    }.items())
    engine = '    let flutterViewController = FlutterViewController()'
    if code.count(engine) != 1:
        raise RuntimeError('Native fixture startup insertion point changed')
    code = code.replace(engine, setup + '\n' + engine)
code += '\n' + (source / 'tool/native_benchmark/NativeBenchmark.swift').read_text()
window.write_text(code)
if args.core_workflows:
    (root / 'run-config.json').write_text(json.dumps({
        'terminals': args.terminals, 'samples': args.samples,
        'hold': args.hold, 'output': 'core-first.json',
    }, indent=2) + '\n')
info = desktop / 'macos/Runner/Configs/AppInfo.xcconfig'
info.write_text(benchmark_configuration(info.read_text()))
env = dict(os.environ, XDG_CONFIG_HOME=str(root / 'tool-config'))
flutter = str(args.flutter / 'bin/flutter')
log = root / 'build.log'
print(f'BENCHMARK_ROOT={root}', flush=True)
with log.open('w') as output:
    def run(command):
        subprocess.run(command, cwd=desktop, env=env, stdout=output, stderr=subprocess.STDOUT, check=True)
    run([flutter, '--suppress-analytics', 'config', '--enable-swift-package-manager'])
    run([flutter, '--suppress-analytics', 'pub', 'get', '--offline'])
    run([flutter, '--suppress-analytics', 'build', 'macos', '--release', '--config-only', '--no-pub', '--target', 'tool/native_benchmark/main.dart'])
    run(['xcodebuild', '-workspace', 'macos/Runner.xcworkspace', '-scheme', 'Runner', '-configuration', 'Release', '-derivedDataPath', 'build/macos', '-destination', 'platform=macOS,arch=arm64', 'CODE_SIGN_IDENTITY=-', 'CODE_SIGN_STYLE=Manual', 'DEVELOPMENT_TEAM=', 'OTHER_CODE_SIGN_FLAGS=', 'ENABLE_HARDENED_RUNTIME=NO', 'build'])
app = desktop / 'build/macos/Build/Products/Release/Harness Benchmark.app'
if not app.exists():
    raise RuntimeError('Expected isolated bundle was not built')
validate_benchmark_bundle(app)
print(f'BENCHMARK_APP={app}', flush=True)
