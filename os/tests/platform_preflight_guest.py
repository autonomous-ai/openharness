#!/usr/bin/env python3
"""Namespaced PCI fixture for a disposable VM; never install or emulate a Mac."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['check', 'ui'])
    args = parser.parse_args()
    assert os.geteuid() == 0 and Path('/etc/harness-live').is_file(), 'Disposable live guest only'
    assert subprocess.check_output(['lsblk', '-ndo', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    assert os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt'), 'A private mount namespace is required'
    assert subprocess.check_output(['nmcli', 'networking'], text=True).strip() == 'disabled'
    expected = 'This Harness image does not support Apple T2 Macs yet.'
    with tempfile.TemporaryDirectory(prefix='harness-platform-', dir='/run') as directory:
        folder = Path(directory)
        devices = folder / 'devices'
        device = devices / '0000:03:00.0'
        device.mkdir(parents=True)
        for name, value in [('vendor', '0x106b'), ('device', '0x1801'), ('class', '0x088000')]:
            (device / name).write_text(value + '\n')
        # Production still reads /sys. This mount affects only this test process
        # and children, not the VM's normal installer or real PCI bindings.
        subprocess.run(['mount', '--bind', str(devices), '/sys/bus/pci/devices'], check=True, timeout=10)
        subprocess.run(['mount', '-o', 'remount,bind,ro', '/sys/bus/pci/devices'], check=True, timeout=10)
        installer_path = Path('/usr/lib/harness-os/install.py')
        hardware_path = installer_path.with_name('hardware.py')
        if args.mode == 'ui':
            os.execv('/usr/bin/python3', ['python3', str(installer_path), '--boot'])
        hardware = load('hardware', hardware_path)
        installer = load('installer', installer_path)
        report = hardware.report()
        assert report['installation_blocker'] == expected, report
        config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                      username='me', hostname='harness', password='test-password-123', encrypt=True)
        config_path = folder / 'install.json'
        config_path.write_text(json.dumps(config))
        started = time.monotonic()
        result = subprocess.run(['python3', str(installer_path), '--config', str(config_path), '--yes-erase-disk'],
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
        assert result.returncode == 1 and result.stdout.strip() == 'Installation stopped: ' + expected, result
        try:
            installer.install(config, installer.live_payload(), Path('/mnt/harness-os'))
        except ValueError as error:
            assert str(error) == expected, str(error)
        else:
            raise AssertionError('The direct installation backend accepted a T2 platform')
        assert not Path('/mnt/harness-os').exists(), 'Preflight created an installation target'
        print('HN_PLATFORM_RESULT=' + json.dumps({
            'status': 'passed', 'cli_status': result.returncode, 'cli_output': result.stdout.strip(),
            'backend_refusal': expected, 'hardware_blocker': report['installation_blocker'],
            'real_dmi': report['computer'], 'fixture_pci_ids': [device['id'] for device in report['pci']],
            'hardware_sha256': hashlib.sha256(hardware_path.read_bytes()).hexdigest(),
            'installer_sha256': hashlib.sha256(installer_path.read_bytes()).hexdigest(),
            'boot_profile_sha256': hashlib.sha256(installer_path.with_name('boot_profile.py').read_bytes()).hexdigest(),
            'elapsed_seconds': round(time.monotonic() - started, 3),
        }), flush=True)


if __name__ == '__main__':
    main()
