#!/usr/bin/env python3
"""Exercise cleanup with real dm-crypt holders on an owned temporary loop disk."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
from unittest.mock import patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installer', type=Path, default=Path(__file__).resolve().parents[1] / 'installer.py')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if os.uname().sysname != 'Linux' or os.geteuid() != 0:
        parser.error('Run as root in a disposable Linux VM with cryptsetup, Btrfs and loop devices.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    spec = importlib.util.spec_from_file_location('installer', args.installer)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    started = time.monotonic()
    result = {'status': 'running', 'architecture': os.uname().machine,
              'kernel': os.uname().release, 'checks': [],
              'installer_sha256': hashlib.sha256(args.installer.read_bytes()).hexdigest()}
    mapper = f'hn-cleanup-test-{os.getpid()}'
    mapped = Path('/dev/mapper') / mapper
    assert not mapped.exists()
    loop, holder, timer = None, None, None
    try:
        with tempfile.TemporaryDirectory(prefix='harness-cleanup-') as temporary:
            root = Path(temporary)
            disk, mount = root / 'disk.raw', root / 'root'
            mount.mkdir()
            with disk.open('wb') as image:
                image.truncate(256 * 1024**2)

            def run(*command, **kwargs):
                return subprocess.run(list(map(str, command)), check=True, timeout=15,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)

            def open_mapping():
                # The fixture tests dm-crypt close behavior, not passphrase KDFs.
                # Its random, throwaway key is supplied only over stdin.
                run('cryptsetup', 'open', '--type', 'plain', '--cipher', 'aes-xts-plain64',
                    '--key-size', '256', '--key-file=-', loop, mapper, input=key)

            key = os.urandom(32)
            loop = run('losetup', '--find', '--show', disk).stdout.decode().strip()
            assert re.fullmatch(r'/dev/loop\d+', loop)
            result['cryptsetup'] = run('cryptsetup', '--version').stdout.decode().strip()
            try:
                open_mapping()
                run('mkfs.btrfs', '-f', mapped)
                run('mount', mapped, mount)
                run('btrfs', 'subvolume', 'create', mount / 'home')
                run('mount', '-o', 'subvol=home', mapped, mount / 'home')
                (mount / 'marker').write_text('keep the completed installation\n')
                (mount / 'home' / 'project').write_text('keep the trial project\n')
                run('sync', '-f', mount)
                # A raw-device reader survives filesystem unmount, just like
                # a probe which is still inspecting the newly written device.
                holder = os.open(mapped, os.O_RDONLY)
                run('umount', '-R', mount)
                baseline = subprocess.run(['cryptsetup', 'close', mapper],
                                          capture_output=True, text=True, timeout=15)
                (output / 'baseline-close.txt').write_text(baseline.stdout + baseline.stderr)
                assert baseline.returncode == 5, baseline
                assert mapped.exists()
                result['checks'].append('Unmodified close returns 5 with the filesystem unmounted and a device reader open')

                def wait_removed():
                    deadline = time.monotonic() + 5
                    while mapped.exists() and time.monotonic() < deadline:
                        time.sleep(.05)
                    assert not mapped.exists(), 'Kernel did not remove the mapping after its last reader closed'

                timer = threading.Timer(1.5, os.close, args=(holder,))
                timer.start()
                holder = None  # The joined timer owns this descriptor now.
                retried = time.monotonic()
                with installer.command_log(output / 'transient-close.log'):
                    installer.close_install_mapping(mapper)
                timer.join()
                timer = None
                wait_removed()
                result['transient_close_seconds'] = round(time.monotonic() - retried, 3)
                result['checks'].append('Cleanup schedules safe removal while a temporary reader finishes')

                open_mapping()
                holder = os.open(mapped, os.O_RDONLY)
                persistent = time.monotonic()
                with installer.command_log(output / 'persistent-close.log'):
                    installer.close_install_mapping(mapper, timeout=2)
                assert mapped.exists()
                result['persistent_close_seconds'] = round(time.monotonic() - persistent, 3)
                assert result['persistent_close_seconds'] < 3
                result['checks'].append('An unmounted device with a persistent reader is queued for removal, never forced closed')
                os.close(holder)
                holder = None
                wait_removed()
                # Inject the actual subprocess timeout seen on the ThinkPad;
                # the fallback still operates on a real held dm-crypt device.
                open_mapping()
                holder = os.open(mapped, os.O_RDONLY)
                original_run = installer.run
                def slow_cryptsetup(*command, **kwargs):
                    if command[0] == 'cryptsetup':
                        subprocess.run(['sleep', '2'], check=True, timeout=.05)
                    return original_run(*command, **kwargs)
                with installer.command_log(output / 'timeout-close.log'), patch.object(installer, 'run', side_effect=slow_cryptsetup):
                    installer.close_install_mapping(mapper)
                assert mapped.exists()
                os.close(holder)
                holder = None
                wait_removed()
                result['checks'].append('A real subprocess timeout falls back to deferred kernel removal without udev synchronization')
                # Reopen the same filesystem and verify the completed data was
                # not modified by either failed or retried close operation.
                open_mapping()
                run('mount', mapped, mount)
                assert (mount / 'marker').read_text() == 'keep the completed installation\n'
                assert (mount / 'home' / 'project').read_text() == 'keep the trial project\n'
                run('umount', '-R', mount)
                installer.close_install_mapping(mapper)
                result['checks'].append('The filesystem and project remain intact after deferred removal and timeout recovery')
            finally:
                if timer is not None:
                    timer.join(timeout=5)
                if holder is not None:
                    os.close(holder)
                if mount.is_mount():
                    run('umount', '-R', mount)
                if mapped.exists():
                    installer.close_install_mapping(mapper)
                if loop is not None:
                    run('losetup', '--detach', loop)
        result['status'] = 'passed'
    except BaseException as error:
        result.update(status='failed', error=repr(error))
        raise
    finally:
        result['duration_seconds'] = round(time.monotonic() - started, 3)
        (output / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2), flush=True)


if __name__ == '__main__':
    main()
