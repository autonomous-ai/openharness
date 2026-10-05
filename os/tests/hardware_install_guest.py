#!/usr/bin/env python3
"""Exercise the real offline installer with an explicit radio-selection fixture.

QEMU has no Broadcom radio. Only device discovery is substituted; the image's
installer, bundle verification, pacman, signature checks and DKMS run normally.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def apply_candidate(source, destination, expected):
    data = source.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise ValueError('Candidate hardware policy checksum mismatch.')
    destination.write_bytes(data)
    destination.chmod(0o755)
    return actual


def assigned_devices(hardware, sysfs):
    """Exercise discovery and activation with private files, never real PCI nodes."""
    expected = []
    for index, (driver, override) in enumerate([
            ('vfio-pci', '(null)'), (None, 'none'),
            ('bcma-pci-bridge', 'bcma-pci-bridge')]):
        path = sysfs / 'bus/pci/devices' / f'0000:{index + 3:02x}:00.0'
        path.mkdir(parents=True)
        for name, value in [('vendor', '0x14e4'), ('device', '0x43a0'),
                            ('class', '0x028000'), ('driver_override', override)]:
            (path / name).write_text(value + '\n')
        if driver:
            binding = sysfs / 'bus/pci/drivers' / driver
            binding.mkdir(parents=True)
            (binding / 'unbind').touch()
            (path / 'driver').symlink_to(binding)
        expected.append((path, driver, override))
    devices = hardware.pci_devices(sysfs)
    assert len(devices) == len(expected)
    original_run = hardware.run

    def forbidden_command(*args, **kwargs):
        raise AssertionError('Assigned PCI device triggered a module operation: ' + repr(args))

    hardware.run = forbidden_command
    try:
        for device, (path, driver, override) in zip(devices, expected):
            assert device['id'] == '14e4:43a0' and device['class'] == '028000'
            assert not hardware.needs_broadcom(device), device
            assert hardware.activate(path.name, sysfs)['status'] == 'unchanged'
            assert (path / 'driver_override').read_text() == override + '\n'
            if driver:
                assert (path / 'driver/unbind').read_text() == ''
    finally:
        hardware.run = original_run
    return devices


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-hardware', type=Path)
    parser.add_argument('--candidate-sha256')
    options = parser.parse_args()
    if bool(options.candidate_hardware) != bool(options.candidate_sha256):
        parser.error('The candidate and its checksum must be supplied together.')
    assert os.geteuid() == 0 and Path('/etc/harness-live').is_file(), 'Disposable live guest only'
    assert subprocess.check_output(['lsblk', '-ndo', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    hardware_path = Path('/usr/lib/harness-os/hardware.py')
    original_hash = hashlib.sha256(hardware_path.read_bytes()).hexdigest()
    if options.candidate_hardware:
        apply_candidate(options.candidate_hardware, hardware_path, options.candidate_sha256)
    hardware = load('hardware', '/usr/lib/harness-os/hardware.py')
    installer = load('installer', '/usr/lib/harness-os/install.py')
    assert subprocess.check_output(['nmcli', 'networking'], text=True).strip() == 'disabled'
    bundle = hardware.bundle_manifest(hardware.BUNDLE, all_files=True)
    baseline = subprocess.check_output(['pacman', '-Q'], text=True)
    for name in ['broadcom-wl-dkms', 'dkms', 'gcc', 'linux-lts-headers']:
        assert not any(line.startswith(name + ' ') for line in baseline.splitlines())
    hardware.run('modprobe', 'cfg80211')
    hardware.run('insmod', hardware.BUNDLE / bundle['module'])
    assert Path('/sys/module/wl').is_dir()
    hardware.run('rmmod', 'wl')

    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123',
                  encrypt=True, serial_console=True)
    installer.selected_disk(config)
    devices = [dict(address='0000:03:00.0', id='14e4:43a0',
                    **{'class': '028000'}, driver=None, interfaces=[])]
    original_run = installer.run
    hardware_hash = hashlib.sha256(hardware_path.read_bytes()).hexdigest()
    evidence = {'image_hardware_sha256': original_hash, 'hardware_sha256': hardware_hash}

    def hardware_selection(*args, **kwargs):
        if args[:3] != ('/usr/bin/python3', '/usr/lib/harness-os/hardware.py', 'configure-install'):
            return original_run(*args, **kwargs)
        target = Path(args[3])
        assert target == Path('/mnt/harness-os') and target.is_mount() and (target / 'etc/harness-live').is_file()
        installed_hardware = target / hardware_path.relative_to('/')
        # The extracted payload still contains the base policy. Install the same
        # explicitly identified candidate before hardware setup and mkinitcpio.
        if options.candidate_hardware:
            apply_candidate(hardware_path, installed_hardware, hardware_hash)
        assert hashlib.sha256(installed_hardware.read_bytes()).hexdigest() == hardware_hash
        module = target / hardware.BUNDLE.relative_to('/') / bundle['module']
        original_module = module.read_bytes()
        before = hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True)
        with tempfile.TemporaryDirectory(prefix='harness-pci-', dir='/run') as directory:
            reserved = assigned_devices(hardware, Path(directory))
            result = hardware.configure_install(target, reserved)
            assert result == {'drivers': [], 'devices': []}, result
            assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
            assert not module.parent.exists()
            evidence['explicit_assignments'] = {'devices': reserved, 'packages_unchanged': True,
                                                'activation_unchanged': True, 'optional_cache_removed': True}
        # The negative installation pruned only this target's optional cache.
        # Restore it from the untouched USB for the positive offline transaction.
        shutil.copytree(hardware.BUNDLE, module.parent)
        # Corruption must fail before a package transaction or binding change.
        module.write_bytes(b'corrupt-module')
        try:
            hardware.configure_install(target, devices)
        except ValueError as error:
            assert 'checksum' in str(error), error
        else:
            raise AssertionError('The installer accepted a damaged Wi-Fi bundle')
        finally:
            module.write_bytes(original_module)
        assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
        started = time.monotonic()
        result = hardware.configure_install(target, devices)
        after = hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True)
        old = dict(line.split(' ', 1) for line in before.splitlines())
        new = dict(line.split(' ', 1) for line in after.splitlines())
        assert all(new.get(name) == version for name, version in old.items()), 'An existing base package changed'
        added = {name: version for name, version in new.items() if name not in old}
        assert added == {value['name']: value['version'] for value in bundle['packages'].values()}, added
        assert not (target / hardware.BUNDLE.relative_to('/')).exists()
        assert result['drivers'] == ['broadcom-wl-dkms']
        assert hardware.run('arch-chroot', target, 'modinfo', '-k', bundle['kernel'], '-F', 'vermagic', 'wl', capture=True).split()[0] == bundle['kernel']
        overrides = hardware.run('arch-chroot', target, 'modprobe', '--showconfig', capture=True)
        for name in ['b43', 'brcmfmac', 'brcmsmac', 'bcma', 'ssb']:
            assert 'blacklist ' + name not in overrides.splitlines(), 'A native driver was globally blocked'
        assert 'blacklist wl' in overrides.splitlines()
        evidence.update(optional_packages=added, offline_prepare_seconds=round(time.monotonic() - started, 3),
                        corrupted_bundle_rejected=True, cache_removed=True, base_packages_unchanged=True,
                        native_drivers_preserved=True, hardware_state=result)
        return None

    installer.run = hardware_selection
    started = time.monotonic()
    installer.install(config, installer.live_payload(), Path('/mnt/harness-os'))
    assert 'optional_packages' in evidence, 'The actual installer did not invoke hardware preparation'
    evidence.update(status='passed', kernel=bundle['kernel'], installation_seconds=round(time.monotonic() - started, 3),
                    scope='Offline encrypted installation with synthetic PCI selection; no physical radio')
    print('HN_HARDWARE_RESULT=' + json.dumps(evidence), flush=True)


if __name__ == '__main__':
    main()
