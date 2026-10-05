#!/usr/bin/env python3
"""Exercise the real offline installer with an explicit radio-selection fixture.

QEMU has no Broadcom radio. Only device discovery is substituted; the image's
installer, bundle verification, pacman, signature checks and DKMS run normally.
"""
import importlib.util
import json
from pathlib import Path
import subprocess
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
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
    evidence = {}

    def hardware_selection(*args, **kwargs):
        if args[:3] != ('/usr/bin/python3', '/usr/lib/harness-os/hardware.py', 'configure-install'):
            return original_run(*args, **kwargs)
        target = Path(args[3])
        module = target / hardware.BUNDLE.relative_to('/') / bundle['module']
        original_module = module.read_bytes()
        before = hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True)
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
    assert evidence, 'The actual installer did not invoke hardware preparation'
    evidence.update(status='passed', kernel=bundle['kernel'], installation_seconds=round(time.monotonic() - started, 3),
                    scope='Offline encrypted installation with synthetic PCI selection; no physical radio')
    print('HN_HARDWARE_RESULT=' + json.dumps(evidence), flush=True)


if __name__ == '__main__':
    main()
