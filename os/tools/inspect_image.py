#!/usr/bin/env python3
"""Inspect the actual ISO payload, independently of the image's staging tree."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


def sha256(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def inspect(iso):
    source = Path(__file__).resolve().parents[1]
    manifest = json.loads((iso.parent / 'manifest.json').read_text())
    assert iso.name == manifest['iso']['name'] and iso.stat().st_size == manifest['iso']['bytes']
    assert sha256(iso) == manifest['iso']['sha256'], 'ISO checksum mismatch'
    report = subprocess.run(['xorriso', '-no_rc', '-indev', str(iso), '-report_el_torito', 'plain', '-report_system_area', 'plain'], check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout
    (iso.parent / 'boot-layout.txt').write_text(report)
    for platform in ['BIOS', 'UEFI']:
        assert re.search(r'El Torito boot img\s*:.*\b' + platform + r'\b', report), f'{platform} boot entry is missing'
    checked = []
    with tempfile.TemporaryDirectory(prefix='hn-iso-inspect-') as temp:
        payload = Path(temp) / 'airootfs.sfs'
        subprocess.run(['xorriso', '-no_rc', '-osirrox', 'on', '-indev', str(iso), '-extract', '/arch/x86_64/airootfs.sfs', str(payload)], check=True)
        def read(path):
            return subprocess.check_output(['unsquashfs', '-cat', str(payload), path])
        files = {str(p.relative_to(source / 'root')): p for p in (source / 'root').rglob('*') if p.is_file()}
        files.update({'usr/lib/harness-os/install.py': source / 'installer.py',
                      'usr/lib/harness-os/onboarding.py': source / 'onboarding.py',
                      'usr/lib/harness-os/network.py': source / 'network.py',
                      'usr/lib/harness-os/projects.py': source / 'projects.py',
                      'usr/lib/harness-os/trial_projects.py': source / 'trial_projects.py',
                      'usr/lib/harness-os/system.py': source / 'system.py',
                      'usr/lib/harness-os/boot_profile.py': source / 'boot_profile.py',
                      'usr/lib/harness-os/t2_install.py': source / 't2_install.py',
                      'usr/lib/harness-os/t2_firmware.py': source / 'tools/prepare-t2-firmware.py',
                      'usr/lib/harness-os/firmware_names.py': source / 'platforms/apple-t2/firmware_names.py',
                      'usr/share/harness-os/apple-t2/kernel.json': source / 'platforms/apple-t2/kernel.json',
                      'usr/lib/harness-os/runtime_update.py': source / 'runtime_update.py',
                      'usr/lib/harness-os/live_update.py': source / 'live_update.py',
                      'usr/lib/harness-os/release_update.py': source / 'release_update.py',
                      'usr/lib/harness-os/hardware.py': source / 'hardware.py',
                      'usr/lib/harness-os/gpu_health.py': source / 'gpu_health.py',
                      'usr/lib/harness-os/gpu_probe.py': source / 'gpu_probe.py',
                      'usr/bin/hn-os': source / 'tools/hn-os',
                      'usr/share/harness-os/lock.json': source / 'lock.json',
                      'usr/share/harness-os/guide/tui.md': source.parent / 'tui/README.md',
                      'usr/share/harness-os/guide/naming.md': source.parent / 'docs/naming-system.md'})
        for path, expected in files.items():
            assert read(path) == expected.read_bytes(), f'Payload does not match source: {path}'
            checked.append(path)
        listing = subprocess.check_output(['unsquashfs', '-lln', str(payload)], text=True)
        owners = {}
        for line in listing.splitlines():
            fields = line.split(maxsplit=5)
            if len(fields) == 6 and fields[1].count('/') == 1 and fields[5].startswith('squashfs-root'):
                path = fields[5].split(' -> ', 1)[0] if fields[0].startswith('l') else fields[5]
                owners[path.removeprefix('squashfs-root').lstrip('/')] = fields[1]
        for path in [*files, '', 'etc', 'usr', 'usr/bin', 'usr/lib/harness-os', 'usr/share/harness-os']:
            assert owners.get(path) == '0/0', f'Packaged system path is not owned by root: {path}'
        runtime = json.loads(read('usr/share/harness-os/runtime.json'))
        guide = json.loads(read('usr/share/harness-os/guide/source.json'))
        assert guide == {'source_commit': manifest['source_commit'], 'tui_reference': 'tui/README.md'}, 'Agent guide belongs to a different source'
        assert read('home/me/.config/opencode/AGENTS.md') == read('etc/skel/.config/opencode/AGENTS.md')
        assert read('home/me/.config/opencode/opencode.json') == read('etc/skel/.config/opencode/opencode.json')
        assert runtime == manifest['harness_inputs'] and runtime['source_commit'] == manifest['source_commit']
        assert not runtime['dirty'] and runtime['target'] == 'x86_64-unknown-linux-musl'
        for name, identity in runtime['files'].items():
            data = read('usr/lib/harness/' + name)
            assert len(data) == identity['bytes'] and hashlib.sha256(data).hexdigest() == identity['sha256'], f'Runtime mismatch: {name}'
        compositor = json.loads(read('usr/share/harness-os/compositor.json'))
        assert compositor == manifest['compositor'], 'Compositor differs from the image manifest'
        assert compositor['source_commit'] == manifest['source_commit'], 'Compositor belongs to another source'
        assert compositor['upstream'] == json.loads((source / 'packaging/labwc/source.json').read_text())
        assert '-Dxwayland=enabled' in compositor['build_options']
        entries = {'usr/lib/harness-os/labwc': compositor['binary']}
        entries.update({'usr/share/licenses/harness-os/labwc/' + name: info
                        for name, info in compositor['corresponding_source'].items()})
        for name, info in entries.items():
            data = read(name)
            assert len(data) == info['bytes'] and hashlib.sha256(data).hexdigest() == info['sha256'], name
            assert owners.get(name) == '0/0', name
            checked.append(name)
        kernel = json.loads(read('usr/share/harness-os/kernel.json'))
        assert re.fullmatch(r'usr/lib/modules/[a-zA-Z0-9._+-]+/vmlinuz', kernel['path'])
        assert hashlib.sha256(read(kernel['path'])).hexdigest() == kernel['sha256'], 'Offline install kernel mismatch'
        platform = manifest['platform']
        assert platform in {'pc', 'apple-t2'}
        assert json.loads(read('etc/harness-platform.json')) == {'schema': 1, 'id': platform}
        assert kernel['platform'] == platform
        pkgbase = 'linux-lts' if platform == 'pc' else 'linux-t2'
        assert read(str(Path(kernel['path']).with_name('pkgbase'))).decode().strip() == pkgbase
        packages = read('usr/share/harness-os/packages.txt').decode()
        assert packages == (iso.parent / 'packages.txt').read_text(), 'Package inventory mismatch'
        inventory = dict(row.split(maxsplit=1) for row in packages.splitlines())
        names = set(inventory)
        assert 'labwc' not in names, 'Fresh image contains a duplicate compositor'
        assert set(compositor['runtime_dependencies']) <= names, 'A compositor library is missing'
        version = json.loads(read('usr/share/harness-os/lock.json'))['version']
        assert version == manifest['version'], 'Image version differs from the build manifest'
        package_version = inventory['harness-os']
        expected_version = re.escape(version.replace('-preview.', 'pre')) + r'\.r\d+\.g' + manifest['source_commit'][:10] + '-1'
        assert re.fullmatch(expected_version, package_version), 'OS package version differs from the image source'
        assert package_version == manifest['package_version'], 'OS package version differs from the manifest'
        capabilities = {'runtime-updates', 'system-updates', 'single-action-updates', 'install-first'}
        capabilities |= {'broadcom-offline', 'nvidia-offline'} if platform == 'pc' else {'t2-kernel', 'apple-firmware-preservation'}
        assert set(manifest['capabilities']) == capabilities, 'Image capabilities differ from the manifest'
        assert not names & {'gcc', 'make', 'dkms', 'broadcom-wl-dkms', 'linux-lts-headers', 'linux-t2-headers'}, 'Hardware build tools entered the default image'
        assert not names & {'nvidia-utils', 'nvidia-open-lts'}, 'Optional GPU packages entered the generic image'
        if platform == 'pc':
            assert set(manifest['hardware']) == {'broadcom', 'nvidia'}
            for driver in ['broadcom', 'nvidia']:
                prefix = 'usr/share/harness-os/hardware/' + driver + '/'
                hardware = json.loads(read(prefix + 'manifest.json'))
                assert hardware == manifest['hardware'][driver], 'Hardware manifest differs from the payload'
                assert hardware['kernel'] == Path(kernel['path']).parent.name, 'Driver targets another kernel'
                assert hardware['arch_snapshot'] == manifest['arch_snapshot']
                assert all(inventory.get(name) == version for name, version in hardware['base_packages'].items())
                for name, expected in hardware['files'].items():
                    assert not Path(name).is_absolute() and '..' not in Path(name).parts
                    path = prefix + name
                    data = read(path)
                    assert len(data) == expected['bytes'] and hashlib.sha256(data).hexdigest() == expected['sha256'], f'Hardware bundle mismatch: {name}'
                    assert owners.get(path) == '0/0', f'Hardware file is not root-owned: {name}'
        else:
            assert set(manifest['hardware']) == {'apple-t2'}
            hardware = json.loads(read('usr/share/harness-os/apple-t2/manifest.json'))
            pin = json.loads((source / 'platforms/apple-t2/kernel.json').read_text())
            assert hardware == manifest['hardware']['apple-t2'] and hardware['kernel'] == pin
            assert inventory['linux-t2'] == pin['package']['version'] and 'linux-lts' not in names
            assert Path(kernel['path']).parent.name == pin['kernel_release']
            assert read('etc/mkinitcpio.conf.d/20-harness-platform.conf').decode() == 'MODULES+=(' + ' '.join(pin['early_modules']) + ')\n'
            assert read('etc/modules-load.d/harness-t2.conf') == b't2bce_vhci\n'
            assert b'Exec = /usr/bin/python3 /usr/lib/harness-os/t2_install.py restore' in read('etc/pacman.d/hooks/80-harness-t2-firmware.hook')
            assert set(hardware['verified_files']) == {'.PKGINFO', 'pkgbase', 'vmlinuz', *pin['required_modules']}
            for name, expected in hardware['verified_files'].items():
                if name == '.PKGINFO':
                    continue  # This is package metadata, not an installed file.
                assert expected['path'].startswith('usr/lib/modules/' + pin['kernel_release'] + '/')
                data = read(expected['path'])
                assert len(data) == expected['bytes'] and hashlib.sha256(data).hexdigest() == expected['sha256']
            assert not any(path.endswith('harness-apple-firmware.tar') or path.endswith('apple-firmware.tar') for path in owners), 'A private Apple firmware export entered the ISO'
        wanted = {row.strip() for row in (source / 'packages.x86_64').read_text().splitlines() if row.strip() and not row.startswith('#')}
        if platform == 'apple-t2':
            wanted = (wanted - {'linux-lts'}) | {'linux-t2'}
        assert wanted.issubset(names), f'Missing packages: {wanted - names}'
        config = read('etc/pacman.conf').decode()
        assert config.count('/' + manifest['arch_snapshot'] + '/') == 2 and '[harness-build]' not in config
        assert 'SigLevel = Required DatabaseOptional' in config
        for repo in ['core', 'extra']:
            assert len(read(f'usr/share/harness-os/repository-databases/{repo}.db')) > 65536, f'Missing offline {repo} repository database'
        assert b'me:x:1000:' in read('etc/passwd'), 'Live user was not created'
        assert b'--autologin me' in read('etc/systemd/system/getty@tty1.service.d/autologin.conf')
        assert read('etc/hostname').strip() == b'harness'
        assert 'etc/harness-live' in owners, 'Live welcome marker is missing'
        for executable in ['usr/bin/opencode', 'usr/bin/nmtui', 'usr/bin/nmtui-connect']:
            assert owners.get(executable) == '0/0', f'Missing or non-root-owned executable: {executable}'
        receipt = {'status': 'passed', 'scope': 'ISO boot entries, exact SquashFS configuration, runtime and offline kernel hashes, live account and package inventory',
                   'source_commit': manifest['source_commit'], 'iso_sha256': manifest['iso']['sha256'],
                   'payload_sha256': sha256(payload), 'package_count': len(names), 'source_files_compared': checked,
                   'limitations': 'Does not establish that the guest boots, installs, recovers or supports physical hardware.'}
    (iso.parent / 'inspection.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'source_files_compared'}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    inspect(parser.parse_args().iso.resolve())
