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
        raise ValueError('Candidate OS file checksum mismatch.')
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


def check_cache_extraction(installer, hardware):
    """Compare actual SquashFS extraction, without extrapolating timing savings."""
    with tempfile.TemporaryDirectory(prefix='harness-cache-', dir='/run') as directory:
        root = Path(directory)
        source = root / 'source'
        bundle = source / hardware.BUNDLE.relative_to('/')
        (bundle / 'packages').mkdir(parents=True)
        archive = bundle / 'packages/fixture.pkg.tar.zst'
        archive.write_bytes(bytes(range(256)) * 256)
        module = bundle / 'wl.ko'
        module.write_bytes(b'preserved module')
        manifest = {'packages': {archive.name: {}}, 'files': {
            str(path.relative_to(bundle)): {'bytes': path.stat().st_size, 'sha256': hardware.digest(path)}
            for path in [archive, module]}}
        (bundle / 'manifest.json').write_text(json.dumps(manifest))
        (bundle.parent / 'preserved').write_text('other hardware')
        (source / 'ordinary').write_text('ordinary file')
        image = root / 'fixture.sfs'
        hardware.run('mksquashfs', source, image, '-noappend', '-no-progress', '-processors', '1')
        baseline, candidate = root / 'baseline', root / 'candidate'
        installer.copy_image(image, baseline, broadcom=root / 'unavailable-cache')
        installer.copy_image(image, candidate, broadcom=bundle)
        for path in [module, bundle / 'manifest.json', bundle.parent / 'preserved', source / 'ordinary']:
            assert (baseline / path.relative_to(source)).read_bytes() == path.read_bytes()
            assert (candidate / path.relative_to(source)).read_bytes() == path.read_bytes()
        assert (baseline / archive.relative_to(source)).read_bytes() == archive.read_bytes()
        assert not (candidate / bundle.relative_to(source) / 'packages').exists()
        size = lambda folder: sum(path.stat().st_size for path in folder.rglob('*') if path.is_file())
        before, after = size(baseline), size(candidate)
        assert before - after == archive.stat().st_size
        return {'baseline_extracted_bytes': before, 'candidate_extracted_bytes': after,
                'archive_bytes_omitted': before - after, 'adjacent_files_preserved': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate-hardware', type=Path)
    parser.add_argument('--candidate-sha256')
    parser.add_argument('--candidate-installer', type=Path)
    parser.add_argument('--installer-sha256')
    options = parser.parse_args()
    if bool(options.candidate_hardware) != bool(options.candidate_sha256):
        parser.error('The candidate and its checksum must be supplied together.')
    if bool(options.candidate_installer) != bool(options.installer_sha256):
        parser.error('The installer candidate and its checksum must be supplied together.')
    assert os.geteuid() == 0 and Path('/etc/harness-live').is_file(), 'Disposable live guest only'
    assert subprocess.check_output(['lsblk', '-ndo', 'SERIAL', '/dev/vda'], text=True).strip() == 'HN_OS_TEST'
    hardware_path = Path('/usr/lib/harness-os/hardware.py')
    installer_path = Path('/usr/lib/harness-os/install.py')
    original_hash = hashlib.sha256(hardware_path.read_bytes()).hexdigest()
    original_installer_hash = hashlib.sha256(installer_path.read_bytes()).hexdigest()
    if options.candidate_hardware:
        apply_candidate(options.candidate_hardware, hardware_path, options.candidate_sha256)
    if options.candidate_installer:
        apply_candidate(options.candidate_installer, installer_path, options.installer_sha256)
    hardware = load('hardware', '/usr/lib/harness-os/hardware.py')
    installer = load('installer', installer_path)
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
    installer_hash = hardware.digest(installer_path)
    evidence = {'image_hardware_sha256': original_hash, 'hardware_sha256': hardware_hash,
                'image_installer_sha256': original_installer_hash, 'installer_sha256': installer_hash,
                'cache_extraction': check_cache_extraction(installer, hardware)}

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
        installed_installer = target / installer_path.relative_to('/')
        if options.candidate_installer:
            apply_candidate(installer_path, installed_installer, installer_hash)
        assert hardware.digest(installed_installer) == installer_hash
        module = target / hardware.BUNDLE.relative_to('/') / bundle['module']
        assert not (module.parent / 'packages').exists(), 'The live package cache was copied to the installed disk'
        evidence['payload_archive_bytes_omitted'] = sum(row['bytes'] for name, row in bundle['files'].items()
                                                      if name.startswith('packages/'))
        original_module = module.read_bytes()
        before = hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True)
        assert hardware.configure_install(target, []) == {'drivers': [], 'devices': []}
        assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
        assert not module.parent.exists()
        evidence['generic_packages_unchanged'] = True
        shutil.copytree(hardware.BUNDLE, module.parent, ignore=shutil.ignore_patterns('packages'))
        with tempfile.TemporaryDirectory(prefix='harness-pci-', dir='/run') as directory:
            reserved = assigned_devices(hardware, Path(directory))
            result = hardware.configure_install(target, reserved)
            assert result == {'drivers': [], 'devices': []}, result
            assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
            assert not module.parent.exists()
            evidence['explicit_assignments'] = {'devices': reserved, 'packages_unchanged': True,
                                                'activation_unchanged': True, 'optional_cache_removed': True}
        # Restore only its small image metadata/module for the positive row.
        shutil.copytree(hardware.BUNDLE, module.parent, ignore=shutil.ignore_patterns('packages'))
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
        small = min((hardware.BUNDLE / 'packages').glob('*.pkg.tar.zst'), key=lambda path: path.stat().st_size)
        original = small.read_bytes()
        small.write_bytes(b'corrupted-archive')
        try:
            hardware.configure_install(target, devices)
        except ValueError as error:
            assert 'checksum' in str(error), error
        else:
            raise AssertionError('The installer accepted a damaged live Wi-Fi archive')
        finally:
            small.write_bytes(original)
        # Hash agreement does not replace pacman's signature verification.
        manifest_path = hardware.BUNDLE / 'manifest.json'
        original_manifest = manifest_path.read_bytes()
        signature = small.with_name(small.name + '.sig')
        original_signature = signature.read_bytes()
        signature.write_bytes(b'invalid-pgp-signature')
        changed = json.loads(original_manifest)
        changed['files'][str(signature.relative_to(hardware.BUNDLE))] = {
            'bytes': signature.stat().st_size, 'sha256': hardware.digest(signature)}
        manifest_path.write_text(json.dumps(changed))
        (module.parent / 'manifest.json').write_text(json.dumps(changed))
        try:
            hardware.configure_install(target, devices)
        except subprocess.CalledProcessError as error:
            assert 'pacman' in error.cmd and '-U' in error.cmd, error
        else:
            raise AssertionError('Pacman accepted an invalid Wi-Fi package signature')
        finally:
            signature.write_bytes(original_signature)
            manifest_path.write_bytes(original_manifest)
            (module.parent / 'manifest.json').write_bytes(original_manifest)
        assert not list((target / 'var/tmp').glob('harness-driver-*')), 'Failed transaction leaked a package mount'
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
                        corrupted_live_archive_rejected=True, invalid_signature_rejected=True,
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
