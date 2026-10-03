#!/usr/bin/env python3
"""Build/run the native release accessibility regression in a disposable macOS app.

Usage: python3 tool/accessibility_regression/run.py --flutter /path/to/flutter
Add --unguarded to verify the known stock-engine crash instead of the fix.
No Harness state, installed app, SDK sources, or system accessibility settings
are changed. A JSON receipt and build/process logs remain in the printed folder.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def now():
    return datetime.now(timezone.utc).isoformat()


def copy_sources(source, destination):
    """Copy the exact production guard and its relative imports, with hashes."""
    pending = [source / 'core/connected_semantics.dart']
    copied = {}
    while pending:
        path = pending.pop().resolve()
        relative = str(path.relative_to(source))
        if relative in copied:
            continue
        data = path.read_bytes()
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        copied[relative] = hashlib.sha256(data).hexdigest()
        for directive in re.findall(r'(?:import|export)\s+[^;]+;', data.decode()):
            for uri in re.findall(r"'([^']+\.dart)'", directive):
                if not uri.startswith(('dart:', 'package:')):
                    pending.append(path.parent / uri)
    return copied


def run(command, cwd, log, deadline, env):
    started = time.monotonic()
    with log.open('w') as output:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=deadline)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
            raise
    return {'exit_code': code, 'seconds': round(time.monotonic() - started, 3),
            'log': str(log)}


def main():
    # Let an outer validation deadline unwind run() and kill only our child
    # process group, including any compiler descendants.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--flutter', type=Path, required=True)
    parser.add_argument('--unguarded', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This fixture requires macOS; no platform row is silently skipped.')
    if shutil.disk_usage(tempfile.gettempdir()).free < 2 * 1024**3:
        parser.error('At least 2 GiB of free disk is required.')
    fixture = Path(__file__).resolve().parent
    source = fixture.parents[1] / 'lib'
    root = Path(tempfile.mkdtemp(prefix='harness-accessibility-'))
    app = root / 'app'
    flutter = str(args.flutter.resolve() / 'bin/flutter')
    env = dict(os.environ, XDG_CONFIG_HOME=str(root / 'tool-config'), FLUTTER_TEST='1')
    receipt = {'started_at': now(), 'unguarded': args.unguarded, 'root': str(root),
               'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip(),
               'steps': [], 'status': 'running'}
    print(f'ACCESSIBILITY_ROOT={root}', flush=True)
    try:
        def checked(name, command, deadline=120):
            step = run(command, root if name == 'create' else app,
                       root / f'{name}.log', deadline, env)
            receipt['steps'].append(dict(name=name, **step))
            if step['exit_code']:
                raise RuntimeError(f'{name} failed; see {step["log"]}')
        checked('create', [flutter, 'create', '--platforms=macos', '--no-pub',
                          '--project-name=harness_ax_regression',
                          '--org=ai.autonomous.accessibilityregression', str(app)])
        (app / 'pubspec.yaml').write_text('''name: harness
publish_to: none
environment:
  sdk: ^3.13.0
dependencies:
  flutter:
    sdk: flutter
  ffi: 2.2.0
  web: 1.1.1
flutter:
  uses-material-design: true
''')
        receipt['production_sources_sha256'] = copy_sources(source, app / 'lib')
        shutil.copyfile(fixture / 'main.dart', app / 'lib/main.dart')
        window = app / 'macos/Runner/MainFlutterWindow.swift'
        swift = window.read_text()
        marker = '    super.awakeFromNib()'
        if swift.count(marker) != 1:
            raise RuntimeError('Flutter macOS template insertion point changed')
        swift = swift.replace(marker, '    AccessibilityRegression.install(window: self, controller: flutterViewController)\n' + marker)
        window.write_text(swift + '\n' + (fixture / 'host.swift').read_text())
        checked('dependencies', [flutter, 'pub', 'get', '--offline'])
        command = [flutter, 'build', 'macos', '--release', '--no-pub']
        if args.unguarded:
            command += ['--dart-define=AX_REGRESSION_UNGUARDED=true']
        checked('build', command, 300)
        bundle = app / 'build/macos/Build/Products/Release/harness_ax_regression.app'
        info = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
        if info['CFBundleIdentifier'] != 'ai.autonomous.accessibilityregression.harnessAxRegression':
            raise RuntimeError(f'Unexpected fixture bundle identity: {info["CFBundleIdentifier"]}')
        step = run([str(bundle / 'Contents/MacOS' / info['CFBundleExecutable'])],
                   app, root / 'native.log', 40, env)
        receipt['steps'].append(dict(name='native', **step))
        output = (root / 'native.log').read_text()
        if args.unguarded:
            # The broken tree can fail while reparenting (SIGSEGV) or while
            # AppKit enumerates its missing children (SIGABRT).
            if step['exit_code'] not in (-signal.SIGSEGV, -signal.SIGABRT) or 'Failed to update ui::AXTree' not in output:
                raise RuntimeError('Expected stock-engine native accessibility crash was not reproduced')
            receipt['status'] = 'baseline_crash_reproduced'
        else:
            if step['exit_code'] != 0 or 'ACCESSIBILITY_REGRESSION_PASS cycles=160 native_actions=160' not in output:
                raise RuntimeError('Native regression did not complete; see native.log')
            if 'ERROR:flutter' in output or 'returned \'kInvalidArguments\'' in output:
                raise RuntimeError('Native bridge reported an error; see native.log')
            receipt['status'] = 'passed'
        print(receipt['status'], flush=True)
    except BaseException as error:
        receipt['status'] = 'failed'
        receipt['error'] = str(error)
        raise
    finally:
        receipt['finished_at'] = now()
        (root / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(f'ACCESSIBILITY_RECEIPT={root / "receipt.json"}', flush=True)


if __name__ == '__main__':
    main()
