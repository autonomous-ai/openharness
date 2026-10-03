#!/usr/bin/env python3
"""Check an exact bridge artifact against the native device implementation.

Offline: does not launch the app, open USB, send a prompt, or transcribe audio.
Physical display/touch/audio checks are a separate, explicitly recorded step.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
CLI = ROOT / 'cli'


def fingerprint(file):
    data = file.read_bytes()
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--firmware-image', type=Path,
                        help='Record its hash; this does not prove binary/source equivalence.')
    args = parser.parse_args()
    args.bundle = args.bundle.resolve(strict=True)
    args.out = args.out.resolve()
    if args.out.exists() and any(args.out.iterdir()):
        parser.error('--out must be an empty directory so old results cannot look current')
    args.out.mkdir(parents=True, exist_ok=True)
    sdk = Path(os.environ.get('IDF_PATH', '')) / 'components/json/cJSON/cJSON.c'
    if not sdk.is_file():
        parser.error('Set IDF_PATH to the firmware SDK; real cJSON replay is required')
    for tool in ['node', 'cc', 'bash']:
        if not shutil.which(tool):
            parser.error(f'{tool} is required')
    loader = CLI / 'node_modules/tsx/dist/loader.mjs'
    if not loader.is_file():
        parser.error('Install the CLI test dependencies first')

    def inputs():
        files = {args.bundle, sdk, sdk.with_name('cJSON.h'), CLI / 'package-lock.json'}
        if args.firmware_image:
            files.add(args.firmware_image.resolve(strict=True))
        for rel in ['devices/harness-device/firmware/main',
                    'devices/harness-device/firmware/test', 'cli/src', 'cli/scripts']:
            files.update(p for p in (ROOT / rel).rglob('*')
                         if p.is_file() and '__pycache__' not in p.parts
                         and p.suffix in {'.c', '.h', '.inc', '.py', '.sh', '.ts', '.mts', '.mjs'})
        # The installed repair can use a standalone parser. Include its bytes too.
        for helper in re.findall(r'[\'"](\./device-(?:activity|usb-fleet)[^\'\"]+)[\'"]',
                                 args.bundle.read_text()):
            files.add((args.bundle.parent / helper).resolve(strict=True))
        return {str(p): fingerprint(p) for p in sorted(files)}

    before = inputs()
    report = {'started': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'scope': 'Built bridge + framed turn/result replay + native sanitizer suite; not hardware E2E',
              'inputs': before, 'stages': [], 'passed': False}
    env = dict(os.environ, SANITIZERS='address,undefined')

    def stage(name, command, cwd=ROOT, timeout=600):
        print(f'{name}: running', flush=True)
        start = time.monotonic()
        with (args.out / (name + '.log')).open('w') as log:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=log,
                                    stderr=subprocess.STDOUT, timeout=timeout)
        report['stages'].append({'name': name, 'exit_code': result.returncode,
                                 'seconds': round(time.monotonic() - start, 2)})
        print(f'{name}: {"PASS" if result.returncode == 0 else "FAIL"}', flush=True)
        if result.returncode:
            raise RuntimeError(f'{name} failed; see {args.out / (name + ".log")}')

    try:
        stage('built-bridge', ['node', '--import', str(loader),
              str(CLI / 'scripts/device-release-check.mts'), '--bundle', str(args.bundle),
              '--out', str(args.out / 'bridge')])
        stage('host-contracts', [str(CLI / 'node_modules/.bin/vitest'), 'run',
              'src/cable', 'src/device/deviceFleet.spec.ts',
              'src/lib/deviceRecap.spec.ts', 'src/lib/deriveTurnSummary.spec.ts',
              'src/lib/sessionInput.spec.ts', 'src/lib/askQuestion.spec.ts',
              'src/lib/summarize.spec.ts'], cwd=CLI)
        env['HABITAT_BRIDGE_TRACE'] = str(args.out / 'bridge/firmware-traces.json')
        env['HABITAT_PREVIEW_DIR'] = str(args.out / 'previews')
        stage('native-sanitizers-and-wire-replay', ['bash', str(HERE / 'run.sh')])
        report['passed'] = True
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        report['error'] = str(error)
    finally:
        after = inputs()
        report['inputs_unchanged'] = before == after
        if before != after:
            report['passed'] = False
            report['changed_inputs'] = [p for p in sorted(before.keys() | after.keys())
                                        if before.get(p) != after.get(p)]
        report['ended'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (args.out / 'release-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'Release checks: {"PASS" if report["passed"] else "FAIL"}; {args.out}', flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
