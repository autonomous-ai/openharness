#!/usr/bin/env python3
"""Measure a disposable Release app + daemon + tmux with four visible terminals.

Requires a connected-resource build from prepare.py and a compiled/calibrated
process_forest_usage.swift. Never installs or controls the user's Harness app.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import signal
import socket
import subprocess
import time

from isolation import validate_benchmark_bundle


def console_session_state():
    """Read only lock metadata; never retain console account names or identifiers."""
    observed = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    try:
        probe = subprocess.run(['/usr/sbin/ioreg', '-n', 'Root', '-d', '1', '-a'],
                               capture_output=True, check=True, timeout=5)
        registry = plistlib.loads(probe.stdout)
        roots = [registry] if isinstance(registry, dict) else registry
        sessions = [session for root in roots if isinstance(root, dict)
                    for session in root.get('IOConsoleUsers', [])
                    if isinstance(session, dict) and session.get('kCGSSessionOnConsoleKey') is True]
        locked = [session.get('CGSSessionScreenIsLocked') for session in sessions]
        # This registry field is not a public API contract. Treat absence as
        # unknown, not unlocked; runtime framework visibility checks still apply.
        state = True if any(value is True for value in locked) else (
            False if locked and all(value is False for value in locked) else None)
        return {'source': 'ioreg IOConsoleUsers', 'observedAt': observed,
                'screenLocked': state, 'onConsoleSessions': len(sessions)}
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, plistlib.InvalidFileException) as error:
        return {'source': 'ioreg IOConsoleUsers', 'observedAt': observed,
                'screenLocked': None, 'unavailable': type(error).__name__}


def rpc(path, command):
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(5)
        client.connect(str(path))
        client.sendall((json.dumps(command) + '\n').encode())
        data = b''
        while b'\n' not in data:
            part = client.recv(65536)
            if not part:
                raise RuntimeError('Fixture connection closed before its reply')
            data += part
            if len(data) > 1048576:
                raise RuntimeError('Unexpectedly large fixture reply')
        result = json.loads(data.split(b'\n', 1)[0])
        if result.get('success') is not True:
            raise RuntimeError(result)
        return result


def wait_for(path, process, seconds=45):
    deadline = time.monotonic() + seconds
    while not path.exists():
        if process.poll() is not None:
            raise RuntimeError(f'Owned process exited: {process.returncode}; waiting for {path.name}')
        if time.monotonic() > deadline:
            raise RuntimeError(f'Timed out waiting for {path.name}')
        time.sleep(0.1)


def validate_visibility(snapshot, visibility, *, previous=None):
    """Reject native-only visibility evidence before accepting resource data."""
    native = snapshot['native']
    framework = snapshot.get('framework')
    if not isinstance(framework, dict):
        raise RuntimeError('Rebuild the connected fixture with framework lifecycle diagnostics')
    expected = {'foreground': 'resumed', 'background': 'hidden'}[visibility]
    if framework.get('lifecycle') != expected:
        raise RuntimeError(
            f'{visibility} phase requires Flutter {expected}; got {framework.get("lifecycle")!r}')
    if framework.get('framesEnabled') is not (visibility == 'foreground'):
        raise RuntimeError('Framework frame scheduling does not match phase visibility')
    if type(framework.get('drawnFrames')) is not int or framework['drawnFrames'] < 0:
        raise RuntimeError('Framework frame count is missing or invalid')
    if visibility == 'foreground' and not (native['key'] and native['active']):
        raise RuntimeError('Foreground phase lost focus')
    if visibility == 'background' and not native['hidden']:
        raise RuntimeError('Background phase is not hidden')
    if (visibility == 'background' and previous is not None
            and previous['framework']['drawnFrames'] != framework['drawnFrames']):
        raise RuntimeError('The hidden framework drew frames during sampling')


def run(args):
    tooling = Path(__file__).resolve().parent
    root = args.root.resolve()
    if not root.name.startswith('harness-connected-') or root.parent != Path('/private/tmp') or root.exists():
        raise ValueError('Use a new /private/tmp/harness-connected-NAME directory')
    app = args.app.resolve()
    validate_benchmark_bundle(app)
    if not str(app).startswith('/private/tmp/harness-native-benchmark-'):
        raise ValueError('Only a disposable benchmark build is permitted')
    helper_args = [str(args.node.resolve()), str(tooling / 'connected_stack.mjs'),
                   f'--root={root}', f'--tmux={args.tmux.resolve()}', f'--terminals={args.terminals}']
    if args.bundle:
        helper_args.append(f'--bundle={args.bundle.resolve()}')
    native = None
    native_log = None
    sampler = None
    result = {'schema': 1, 'success': False, 'root': str(root), 'label': args.label,
              'app': str(app), 'terminals': args.terminals, 'phases': [],
              'toolingSha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                               for path in [Path(__file__), tooling / 'connected_stack.mjs',
                                            tooling / 'connected_worker.mjs', args.sampler.resolve()]},
              'startedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    result['consoleSession'] = console_session_state()
    if result['consoleSession']['screenLocked'] is True:
        result['error'] = 'Unlock the desktop before starting a native resource comparison'
        # Do not create the run directory: connected_stack owns its creation.
        # Preserve this rejection beside it, without replacing prior evidence.
        receipt = root.with_name(root.name + '.preflight.json')
        with receipt.open('x') as output:
            json.dump(result, output, indent=2)
        raise RuntimeError(f'{result["error"]}; preflight: {receipt}')
    # Validate/hash every required input before starting an owned process. A
    # missing sampler must not leave an unattended daemon/tmux launcher behind.
    helper = subprocess.Popen(helper_args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)
    try:
        wait_for(root / 'stack.json', helper)
        manifest = json.loads((root / 'stack.json').read_text())
        result['daemonMetadata'] = {key: manifest[key] for key in
                                    ['bundleSha256', 'sourceRevision', 'sourceDiffSha256', 'boundary']}
        identity = app.parents[6] / 'build-identity.json'
        if identity.exists():
            result['buildIdentity'] = json.loads(identity.read_text())
        env = json.loads((root / 'environment.json').read_text())
        env['HARNESS_CONNECTED_ROOT'] = str(root)
        worker = root / 'worker.mjs'
        shutil.copyfile(tooling / 'connected_worker.mjs', worker)
        native_log = (root / 'app.log').open('x')
        native = subprocess.Popen(['/usr/bin/sandbox-exec', '-f', str(root / 'isolation.sb'),
                                   str(app / 'Contents/MacOS/Harness Benchmark')],
                                  env=env, cwd=root, stdin=subprocess.DEVNULL,
                                  stdout=native_log, stderr=subprocess.STDOUT)
        wait_for(root / 'app-ready.json', native)
        app_ready = json.loads((root / 'app-ready.json').read_text())
        if app_ready['pid'] != native.pid or app_ready['testMode'] is not False:
            raise RuntimeError('Native fixture identity/test-mode mismatch')
        result['appMetadata'] = app_ready
        control = root / 'app-control.sock'
        for index, agent in enumerate(manifest['agents']):
            # New disposable panes only; normal terminal input starts each worker.
            command = f'HARNESS_CONNECTED_ROOT={shlex.quote(str(root))} exec {shlex.quote(str(args.node.resolve()))} {shlex.quote(str(worker))} {index}\r'
            rpc(control, {'operation': 'input', 'agentId': agent['id'], 'text': command})
        for index in range(args.terminals):
            wait_for(root / f'worker-{index}.sock', native)
        time.sleep(2)
        initial = rpc(control, {'operation': 'status', 'includeText': True})
        if len(initial['panes']) != args.terminals:
            raise RuntimeError('Wrong number of connected panes')
        for index, pane in enumerate(initial['panes']):
            if f'RESOURCE {index} READY' not in pane.get('tail', ''):
                raise RuntimeError(f'Worker output did not reach pane {index}')
        result['initial'] = initial
        print(json.dumps({'ready': True, 'root': str(root), 'appPid': native.pid,
                          'daemonPid': manifest['daemonPid'], 'terminals': args.terminals}), flush=True)
        roots = ','.join(str(value) for value in [native.pid, manifest['daemonPid'], manifest['tmuxPid']])
        phases = [('background', 'idle-hidden'), ('background', 'active')]
        if not args.background_only:
            phases = [('foreground', 'idle-visible'), ('foreground', 'idle-hidden'),
                      ('foreground', 'active')] + phases
        result['backgroundOnly'] = args.background_only
        for visibility, mode in phases:
            label = f'{visibility}-{mode}'
            rpc(control, {'operation': 'show' if visibility == 'foreground' else 'hide'})
            for index in range(args.terminals):
                rpc(root / f'worker-{index}.sock', {'mode': mode})
            time.sleep(args.settle)
            before = rpc(control, {'operation': 'status'})
            # Retain rejected observations too; a missing lifecycle transition
            # must not leave only a generic error after the private app exits.
            result['pendingPhase'] = {'label': label, 'before': before}
            validate_visibility(before, visibility)
            native_state = before['native']
            workers_before = [rpc(root / f'worker-{index}.sock', {}) for index in range(args.terminals)]
            output = root / (label + '.json')
            sampler = subprocess.Popen([str(args.sampler.resolve()), roots, str(args.seconds), label, str(output)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            stdout, stderr = sampler.communicate(timeout=args.seconds + 20)
            if sampler.returncode != 0:
                raise RuntimeError(f'Sampler failed: {stderr}')
            workers_after = [rpc(root / f'worker-{index}.sock', {}) for index in range(args.terminals)]
            after = rpc(control, {'operation': 'status', 'includeText': True})
            result['pendingPhase']['after'] = after
            validate_visibility(after, visibility, previous=before)
            for field in ['key', 'active', 'hidden', 'focusLosses', 'width', 'height', 'scale']:
                if native_state[field] != after['native'][field]:
                    raise RuntimeError(f'Native state changed during {label}: {field}')
            if any(pane['status'] != 'controlling' for pane in after['panes']):
                raise RuntimeError('A terminal disconnected during sampling')
            for index, (start, end) in enumerate(zip(workers_before, workers_after)):
                if start['pid'] != end['pid'] or start['mode'] != mode or end['mode'] != mode:
                    raise RuntimeError('Worker identity or workload changed')
                if mode == 'active':
                    ticks = end['ticks'] - start['ticks']
                    skipped = end['skipped'] - start['skipped']
                    if ticks < args.seconds * 18 or skipped > ticks * 0.02:
                        raise RuntimeError('Workload missed its output-rate requirement')
                    pane = next(pane for pane in after['panes'] if pane['agentId'] == manifest['agents'][index]['id'])
                    if f'RESOURCE {index} FRAME ' not in pane.get('tail', ''):
                        raise RuntimeError('Active output failed to reach a retained terminal')
            resource = json.loads(output.read_text())
            phase = {'label': label, 'before': before, 'after': after,
                     'workersBefore': workers_before, 'workersAfter': workers_after,
                     'resources': output.name, 'summary': resource['summary']}
            result['phases'].append(phase)
            del result['pendingPhase']
            (root / 'run-progress.json').write_text(json.dumps(result, indent=2))
            print(json.dumps({'phase': label, **resource['summary']}), flush=True)
        result['success'] = True
    except BaseException as error:
        result['error'] = repr(error)
        raise
    finally:
        if sampler and sampler.poll() is None:
            sampler.terminate(); sampler.communicate(timeout=5)
        if native and native.poll() is None:
            try:
                rpc(root / 'app-control.sock', {'operation': 'finish'})
                native.wait(timeout=5)
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                if native.poll() is None:
                    native.terminate()
                    try: native.wait(timeout=5)
                    except subprocess.TimeoutExpired: native.kill(); native.wait(timeout=5)
        if native_log:
            native_log.close()
        helper.stdin.close()
        try: helper.wait(timeout=15)
        except subprocess.TimeoutExpired:
            helper.terminate(); helper.wait(timeout=15)
        result['helperExit'] = helper.returncode
        result['nativeExit'] = native.returncode if native else None
        result['helperStdout'] = helper.stdout.read()
        result['helperStderr'] = helper.stderr.read()
        cleanup = root / 'cleanup.json'
        result['cleanup'] = json.loads(cleanup.read_text()) if cleanup.exists() else None
        if (not result['cleanup'] or result['cleanup'].get('success') is not True
                or helper.returncode != 0 or (native and native.returncode != 0)):
            result['success'] = False
        if root.exists():
            with (root / 'run.json').open('x') as output:
                json.dump(result, output, indent=2)
        print(json.dumps({'success': result['success'], 'result': str(root / 'run.json'),
                          'cleanup': result['cleanup']}), flush=True)
    if not result['success']:
        raise RuntimeError('Connected fixture validation or cleanup did not pass')


if __name__ == '__main__':
    def interrupted(_signal, _frame):
        raise KeyboardInterrupt('Connected fixture interrupted; cleaning up owned processes')
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['app', 'root', 'node', 'tmux', 'sampler']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--label', required=True)
    parser.add_argument('--background-only', action='store_true',
                        help='Measure hidden-app idle/output without foreground phases')
    parser.add_argument('--terminals', type=int, choices=range(1, 49), default=10)
    parser.add_argument('--seconds', type=int, choices=range(5, 181), default=30)
    parser.add_argument('--settle', type=int, choices=range(1, 31), default=5)
    run(parser.parse_args())
