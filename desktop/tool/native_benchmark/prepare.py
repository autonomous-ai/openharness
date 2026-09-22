#!/usr/bin/env python3
"""Build an isolated Release benchmark; never rewrite the user's V2 bundle."""
import argparse
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
args = parser.parse_args()
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
if args.interactive or args.flutter_dispatch:
    # Only this copied host gets fixture state. Launching through normal app
    # controls needs no shell environment and never opens a real transport.
    setup = '\n'.join(f'    setenv("{key}", "{value}", 1)' for key, value in {
        'FLUTTER_TEST': '1',
        'HARNESS_NATIVE_BENCHMARK': '1',
        'HARNESS_BENCH_MANUAL': '0' if args.flutter_dispatch else '1',
        'HARNESS_BENCH_FLUTTER': '1' if args.flutter_dispatch else '0',
        'HARNESS_BENCH_OUTPUT': str(root / 'interactive.json'),
    }.items())
    engine = '    let flutterViewController = FlutterViewController()'
    if code.count(engine) != 1:
        raise RuntimeError('Native fixture startup insertion point changed')
    code = code.replace(engine, setup + '\n' + engine)
code += '\n' + (source / 'tool/native_benchmark/NativeBenchmark.swift').read_text()
window.write_text(code)
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
