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
                      'usr/lib/harness-os/system.py': source / 'system.py',
                      'usr/bin/hn-os': source / 'tools/hn-os',
                      'usr/share/harness-os/lock.json': source / 'lock.json'})
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
        assert runtime == manifest['harness_inputs'] and runtime['source_commit'] == manifest['source_commit']
        assert not runtime['dirty'] and runtime['target'] == 'x86_64-unknown-linux-musl'
        for name, identity in runtime['files'].items():
            data = read('usr/lib/harness/' + name)
            assert len(data) == identity['bytes'] and hashlib.sha256(data).hexdigest() == identity['sha256'], f'Runtime mismatch: {name}'
        kernel = json.loads(read('usr/share/harness-os/kernel.json'))
        assert re.fullmatch(r'usr/lib/modules/[a-zA-Z0-9._+-]+/vmlinuz', kernel['path'])
        assert hashlib.sha256(read(kernel['path'])).hexdigest() == kernel['sha256'], 'Offline install kernel mismatch'
        assert read(str(Path(kernel['path']).with_name('pkgbase'))).strip() == b'linux-lts'
        packages = read('usr/share/harness-os/packages.txt').decode()
        assert packages == (iso.parent / 'packages.txt').read_text(), 'Package inventory mismatch'
        inventory = dict(row.split(maxsplit=1) for row in packages.splitlines())
        names = set(inventory)
        version = json.loads(read('usr/share/harness-os/lock.json'))['version']
        assert version == manifest['version'], 'Image version differs from the build manifest'
        assert inventory['harness-os'] == version.replace('-preview.', 'pre') + '-1', 'OS package version differs from the image version'
        wanted = {row.strip() for row in (source / 'packages.x86_64').read_text().splitlines() if row.strip() and not row.startswith('#')}
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
