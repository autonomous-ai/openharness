#!/usr/bin/env python3
"""Quiet, bounded GPU verification for an installed Harness session."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

STATE = Path.home() / '.local/state/harness-os/gpu'
SYS = Path('/sys')
PROC = Path('/proc')
SYSTEM_STATE = Path('/var/lib/harness-os')
PROBE = Path(__file__).with_name('gpu_probe.py')
VERSION = 1
PROBE_SECONDS = 20
TOTAL_SECONDS = 120


def read_json(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def text(path):
    try:
        return path.read_text().strip()
    except (OSError, UnicodeError):
        return ''


def hardware():
    spec = importlib.util.spec_from_file_location('harness_gpu_hardware', Path(__file__).with_name('hardware.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_json(path, value):
    # Same-directory atomic publication; no half-written success after a crash.
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.gpu-', mode='w', delete=False) as handle:
        pending = Path(handle.name)
        try:
            json.dump(value, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
            pending.replace(path)
        finally:
            pending.unlink(missing_ok=True)


def library_identity(path):
    try:
        resolved, info = path.resolve(strict=True), path.stat()
        return {'path': str(resolved), 'bytes': info.st_size, 'mtime_ns': info.st_mtime_ns}
    except OSError:
        return None


def inventory():
    cards = [card for card in hardware().pci_devices(SYS)
             if card['id'].startswith('10de:') and card['class'] in {'030000', '030200'}]
    return {'schema': VERSION, 'boot_id': text(PROC / 'sys/kernel/random/boot_id'),
            'kernel': os.uname().release, 'driver_version': text(SYS / 'module/nvidia/version'),
            'libraries': {name: library_identity(Path('/usr/lib') / name)
                          for name in ['libcuda.so.1', 'libEGL_nvidia.so.0', 'libnvidia-eglcore.so.' + text(SYS / 'module/nvidia/version')]}
            if cards else {}, 'cards': cards,
            'probe_sha256': hashlib.sha256(PROBE.read_bytes()).hexdigest(),
            'controller_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def cached_report():
    report = read_json(STATE / 'health.json')
    if not report:
        return {'status': 'not-tested', 'reason': 'GPU verification has not run for this user.'}
    report['stale'] = report.get('fingerprint') != fingerprint(inventory())
    return report


def probe(kind, address, timeout):
    # Ignore a task's CUDA selection/debug injection in this OS diagnostic. Never
    # change the environment of existing agents, their processes or GPU contexts.
    env = {key: value for key, value in os.environ.items() if not key.startswith(
        ('CUDA_', 'NVIDIA_', '__NV_', '__EGL_', 'LD_'))}
    env.update(CUDA_CACHE_DISABLE='1', CUDA_MODULE_LOADING='EAGER')
    command = [sys.executable, str(PROBE), kind, address]
    failure = None
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=env)
        output, errors = result.stdout, result.stderr
        if result.returncode:
            failure = f'Probe exited with status {result.returncode}'
    except subprocess.TimeoutExpired as error:
        output, errors = error.stdout or b'', error.stderr or b''
        failure = f'Probe exceeded {timeout:.1f} seconds'
    except OSError as error:
        output, errors, failure = '', '', str(error)
    if isinstance(output, bytes):
        output = output.decode(errors='replace')
    if isinstance(errors, bytes):
        errors = errors.decode(errors='replace')
    events = []
    for line in output.splitlines():
        try:
            item = json.loads(line)
            if isinstance(item, dict):
                events.append(item)
        except ValueError:
            pass
    final = events[-1].get('result') if events else None
    if not failure and isinstance(final, dict) and final.get('address') == address and final.get('probe') == kind:
        checks = final.get('checks')
        required = {'cuda.device', 'cuda.memory', 'cuda.compute'} if kind == 'cuda' else {'graphics.render'}
        if (isinstance(checks, list) and all(isinstance(c, dict) and c.get('status') in {'passed', 'failed'} for c in checks)
                and (final.get('status') == 'failed' and any(c['status'] == 'failed' for c in checks)
                     or final.get('status') == 'passed' and all(c['status'] == 'passed' for c in checks)
                     and required <= {c.get('test') for c in checks})):
            final['stderr'] = errors[-2048:]
            return final
    last = {key: next((e[key] for e in reversed(events) if key in e), None) for key in ['stage', 'operation']}
    return {'address': address, 'probe': kind, 'status': 'failed', 'checks': [
        {'test': kind, 'status': 'failed', 'detail': failure or 'Incomplete probe result', **last}], 'stderr': errors[-2048:]}


def connections(address):
    result = {}
    for card in (SYS / 'class/drm').glob('card[0-9]*'):
        if '-' not in card.name and (card / 'device').resolve().name == address:
            for connector in (SYS / 'class/drm').glob(card.name + '-*'):
                result[connector.name] = text(connector / 'status')
    return result


def recovery_context():
    system = read_json(SYSTEM_STATE / 'update.json')
    pointer = read_json(SYSTEM_STATE / 'runtime-updates/latest.json').get('id', '')
    # The root-owned pointer can still be absent or malformed after an interrupted
    # update. A diagnostic never follows an arbitrary path from that JSON.
    runtime = (read_json(SYSTEM_STATE / 'runtime-updates' / pointer / 'receipt.json')
               if isinstance(pointer, str) and re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', pointer) else {})
    return {'system_update': {key: system.get(key) for key in ['snapshot', 'checkpoint', 'exit_status']},
            'harness_update': {key: runtime.get(key) for key in ['checkpoint', 'status']},
            'method': 'Offline checkpoint recovery preserves the home subvolume. No automatic rollback or reboot.'}


def evaluate(current):
    started = time.monotonic()
    installed = read_json(SYSTEM_STATE / 'hardware.json').get('nvidia', {})
    report = {'schema': VERSION, 'fingerprint': fingerprint(current), 'inventory': current,
              'checked_at': datetime.now(timezone.utc).isoformat(), 'devices': [],
              'recovery': recovery_context(), 'limitations': [
                  'A small memory sample and computation, not a full VRAM stress test.',
                  'Offscreen EGL rendering does not verify display scanout, browser acceleration, or sleep/wake.',
                  'No model runtime, GPU reset, driver unload, package change or automatic reboot.']}
    # An intentional assignment must remain untouched, even when this GPU was
    # installed by Harness previously. Missing drivers on managed cards are errors.
    for card in current['cards']:
        record = dict(card, display_connections=connections(card['address']), checks=[])
        report['devices'].append(record)
        if (card.get('driver_override') not in {None, '', 'nvidia'} or card['driver'] not in {None, 'nvidia', 'nouveau'}):
            record.update(status='skipped', reason='GPU is assigned to another driver; its assignment is preserved.')
            continue
        if card['driver'] != 'nvidia':
            managed = installed.get('status') == 'installed' and card['id'] in installed.get('devices', [])
            record.update(status='failed' if managed else 'not-tested', reason='NVIDIA driver is not bound to this GPU.')
            record['checks'].append({'test': 'driver.binding', 'status': record['status'], 'actual': card['driver']})
            continue
        record['checks'].append({'test': 'driver.binding', 'status': 'passed', 'actual': card['driver']})
        for kind in ['cuda', 'graphics']:
            remaining = TOTAL_SECONDS - (time.monotonic() - started)
            if remaining <= 0:
                record['checks'].append({'test': kind, 'status': 'failed', 'detail': 'Overall diagnostic deadline reached; not tested.'})
                continue
            result = probe(kind, card['address'], min(PROBE_SECONDS, remaining))
            for check in result['checks']:
                # A compute-only/headless configuration may deliberately lack
                # graphics. Keep that evidence, without calling CUDA broken.
                unavailable = check.get('operation') in {'load_driver', 'EGL extensions', 'eglQueryDevicesEXT',
                    'graphics.device', 'eglGetPlatformDisplayEXT', 'eglInitialize', 'eglChooseConfig'}
                if kind == 'graphics' and check['status'] == 'failed' and unavailable and 'connected' not in record['display_connections'].values():
                    check = dict(check, status='not-tested', reason='No connected display on this card; graphics remains unverified.')
                record['checks'].append(check)
            if result.get('stderr'):
                record.setdefault('probe_stderr', {})[kind] = result['stderr']
        record['status'] = ('failed' if any(c['status'] == 'failed' for c in record['checks']) else
                            'partial' if any(c['status'] == 'not-tested' for c in record['checks']) else 'passed')
    states = {row['status'] for row in report['devices']}
    report['status'] = ('failed' if 'failed' in states else 'partial' if states & {'partial', 'not-tested'} else
                        'passed' if 'passed' in states else 'skipped')
    report['duration_seconds'] = round(time.monotonic() - started, 3)
    return report


def notify(report):
    if report['status'] != 'failed':
        return False
    try:
        subprocess.run(['/usr/bin/hn', 'display-message', '-d', '10000',
                        'GPU needs attention. Ask your agent to check harness hardware.'],
                       check=True, capture_output=True, timeout=3)
        return True
    except (OSError, subprocess.SubprocessError):
        return False  # The durable report remains available without a UI.


def check(force=False, announce=False):
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE / 'check.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'running', 'reason': 'GPU verification is already running.'}
        current = inventory()
        previous = read_json(STATE / 'health.json')
        # Package replacement can mix a loaded old driver with new userspace.
        # Never wake/check GPUs mid-update, nor report that as a failed new boot.
        if Path('/var/lib/pacman/db.lck').exists() or Path('/run/harness-os-restart-required').exists():
            report = {'schema': VERSION, 'status': 'deferred', 'reason': 'GPU verification will run after the update and restart.',
                      'inventory': current, 'devices': [], 'recovery': recovery_context()}
        else:
            if not force and previous.get('fingerprint') == fingerprint(current):
                return previous
            report = evaluate(current)
            if fingerprint(inventory()) != report['fingerprint'] or Path('/var/lib/pacman/db.lck').exists():
                report['status'] = 'deferred'
                report.pop('fingerprint', None)
                report['reason'] = 'Hardware or driver changed during verification; run again after restart.'
        write_json(STATE / 'health.json', report)
        if report['status'] == 'passed':
            write_json(STATE / 'last-working.json', report)
        if announce:
            notify(report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--force', action='store_true', help='Repeat checks on this boot')
    parser.add_argument('--notify', action='store_true', help='Show only actionable failure in the current Harness session')
    args = parser.parse_args()
    print(json.dumps(check(args.force, args.notify), indent=2))


if __name__ == '__main__':
    main()
