#!/usr/bin/env python3
"""Real offline installation with only PCI discovery replaced by GPU fixtures."""
import importlib.util
import json
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
    hardware = load('hardware', '/usr/lib/harness-os/hardware.py')
    installer = load('installer', '/usr/lib/harness-os/install.py')
    assert subprocess.check_output(['nmcli', 'networking'], text=True).strip() == 'disabled'
    config = dict(disk='/dev/vda', expected_serial='HN_OS_TEST', confirm_erase='/dev/vda',
                  username='me', hostname='harness', password='test-password-123',
                  encrypt=True, serial_console=True)
    installer.selected_disk(config)
    bundle = hardware.nvidia_bundle_manifest(hardware.NVIDIA_BUNDLE, all_files=True)
    # Exercise the actual extraction flags, including directories beside the cache.
    with tempfile.TemporaryDirectory(prefix='harness-copy-', dir='/run') as temp:
        root = Path(temp)
        source, target = root / 'source', root / 'target'
        gpu = source / hardware.NVIDIA_BUNDLE.relative_to('/')
        gpu.mkdir(parents=True)
        (gpu / 'large-cache').write_text('not installed')
        (gpu.parent / 'preserved').write_text('other hardware')
        (source / 'ordinary').write_text('ordinary file')
        hardware.run('mksquashfs', source, root / 'fixture.sfs', '-noappend', '-no-progress', '-processors', '1')
        installer.copy_image(root / 'fixture.sfs', target)
        assert not (target / hardware.NVIDIA_BUNDLE.relative_to('/')).exists()
        assert (target / 'usr/share/harness-os/hardware/preserved').read_text() == 'other hardware'
        assert (target / 'ordinary').read_text() == 'ordinary file'

    def card(identity, driver='nouveau'):
        return dict(address='0000:03:00.0', id=identity, **{'class': '030000'}, driver=driver, interfaces=[])

    targets = ['GeForce RTX 4090', 'GeForce RTX 5090', 'RTX 6000 Ada Generation', 'RTX PRO 6000 Blackwell']
    identities = {name: next(key for key, names in bundle['supported_devices'].items()
                            if any(name in value for value in names)) for name in targets}
    devices = [card(identities[targets[0]])]
    for identity in identities.values():
        assert hardware.nvidia_selection([card(identity)], bundle['supported_devices'])['status'] == 'selected'
    original_run = installer.run
    evidence = {'target_device_ids': identities, 'cache_extraction_excluded': True}

    def hardware_selection(*args, **kwargs):
        if args[:3] != ('/usr/bin/python3', '/usr/lib/harness-os/hardware.py', 'configure-install'):
            return original_run(*args, **kwargs)
        target = Path(args[3])
        before = hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True)
        # Native negative rows must neither add packages nor write boot settings.
        for fixture in [[], [card('10de:1b80')], devices + [card('10de:1b80')],
                        [card(devices[0]['id'], 'vfio-pci')]]:
            result = hardware.configure_nvidia_install(target, fixture)
            assert result is None or result['status'] == 'unchanged', result
            assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
            assert not (target / 'etc/mkinitcpio.conf.d/30-harness-nvidia.conf').exists()
        # A damaged archive must fail before the package transaction.
        small = min((hardware.NVIDIA_BUNDLE / 'packages').glob('*.pkg.tar.zst'), key=lambda p: p.stat().st_size)
        original = small.read_bytes()
        small.write_bytes(b'corrupted-archive')
        try:
            hardware.configure_nvidia_install(target, devices)
        except ValueError as error:
            assert 'checksum' in str(error), error
        else:
            raise AssertionError('A damaged GPU archive was accepted')
        finally:
            small.write_bytes(original)
        assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
        # Match the checksum of a deliberately invalid signature. Pacman itself
        # must still reject it; a hash-only test would not prove authentication.
        manifest_path = hardware.NVIDIA_BUNDLE / 'manifest.json'
        original_manifest = manifest_path.read_bytes()
        signature = small.with_name(small.name + '.sig')
        original_signature = signature.read_bytes()
        signature.write_bytes(b'invalid-pgp-signature')
        changed = json.loads(original_manifest)
        changed['files'][str(signature.relative_to(hardware.NVIDIA_BUNDLE))] = {
            'bytes': signature.stat().st_size, 'sha256': hardware.digest(signature)}
        manifest_path.write_text(json.dumps(changed))
        try:
            hardware.configure_nvidia_install(target, devices)
        except subprocess.CalledProcessError as error:
            assert 'pacman' in error.cmd and '-U' in error.cmd, error
        else:
            raise AssertionError('Pacman accepted an invalid package signature')
        finally:
            signature.write_bytes(original_signature)
            manifest_path.write_bytes(original_manifest)
        assert hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True) == before
        assert not list((target / 'var/tmp').glob('harness-gpu-*')), 'Failed transaction leaked a package mount'
        started = time.monotonic()
        result = hardware.configure_install(target, devices)
        after = hardware.run('arch-chroot', target, 'pacman', '-Q', capture=True)
        old = dict(line.split(' ', 1) for line in before.splitlines())
        new = dict(line.split(' ', 1) for line in after.splitlines())
        assert all(new.get(name) == version for name, version in old.items()), 'A base package changed'
        added = {name: version for name, version in new.items() if name not in old}
        assert added == {value['name']: value['version'] for value in bundle['packages'].values()}, added
        assert not (target / hardware.NVIDIA_BUNDLE.relative_to('/')).exists()
        assert not (target / hardware.BUNDLE.relative_to('/')).exists()
        assert not list((target / 'var/tmp').glob('harness-gpu-*'))
        assert result['drivers'] == ['nvidia-open-lts'] and result['nvidia']['status'] == 'installed'
        evidence.update(optional_packages=added, offline_prepare_seconds=round(time.monotonic() - started, 3),
                        corrupted_archive_rejected=True, invalid_signature_rejected=True,
                        negative_selections_unchanged=True, cache_absent=True, base_packages_unchanged=True,
                        hardware_state=result)
        return None

    installer.run = hardware_selection
    started = time.monotonic()
    installer.install(config, installer.live_payload(), Path('/mnt/harness-os'))
    assert evidence.get('hardware_state'), 'The installer did not invoke hardware preparation'
    evidence.update(status='passed', kernel=bundle['kernel'], driver_version=bundle['driver_version'],
                    installation_seconds=round(time.monotonic() - started, 3),
                    scope='Offline encrypted installation with synthetic PCI selection; no physical GPU')
    print('HN_NVIDIA_RESULT=' + json.dumps(evidence), flush=True)


if __name__ == '__main__':
    main()
