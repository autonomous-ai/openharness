#!/usr/bin/env python3
"""Inspect the produced private ISO, including its actual compressed live root."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

from asahi_image_check import digest


def inspect_root(root, identity):
    data = root / 'usr/share/harness-installer'
    if json.loads((data / 'media.json').read_text()) != identity:
        raise ValueError('The live root lost its exact media provenance.')
    raw = data / 'payload.raw'
    if (raw.is_symlink() or not raw.is_file() or raw.stat().st_size != identity['payload']['bytes'] or
            digest(raw) != identity['payload']['sha256']):
        raise ValueError('The media payload differs from the tested image.')
    for name, checksum in identity['installer'].items():
        file = root / 'usr/lib/harness-installer' / name
        if file.is_symlink() or digest(file) != checksum or file.stat().st_uid != 0 or file.stat().st_mode & 0o022:
            raise ValueError('The installer source changed: ' + name)
    for row in (root / 'etc/passwd').read_text().splitlines():
        if 1000 <= int(row.split(':')[2]) < 65534:
            raise ValueError('Installer media has a login account.')
    shadow = next(r.split(':') for r in (root / 'etc/shadow').read_text().splitlines() if r.startswith('root:'))
    if not shadow[1].startswith(('!', '*')):
        raise ValueError('Installer media has an unlocked root account.')
    if (root / 'etc/machine-id').read_text().strip() not in ('', 'uninitialized'):
        raise ValueError('Installer media has a fixed machine identity.')
    if (root / 'var/lib/systemd/random-seed').exists() or list((root / 'etc/ssh').glob('ssh_host_*_key')):
        raise ValueError('Installer media contains machine secrets.')
    if not re.search('^SELINUX=enforcing$', (root / 'etc/selinux/config').read_text(), re.M):
        raise ValueError('Installer SELinux is not enforcing.')
    if (root / 'boot/efi/m1n1/boot.bin').exists():
        raise ValueError('Removable media must not manage m1n1.')
    enabled = root / 'etc/systemd/system/multi-user.target.wants/harness-installer.service'
    if not enabled.is_symlink() or os.readlink(enabled) != '/usr/lib/systemd/system/harness-installer.service':
        raise ValueError('The installer does not start automatically.')
    for name in ('getty@', 'serial-getty@', 'sshd', 'first-boot', 'initial-setup',
                 'asahi-setup-swap-firstboot', 'asahi-extras-firstboot'):
        mask = root / ('etc/systemd/system/' + name + '.service')
        if not mask.is_symlink() or os.readlink(mask) != '/dev/null':
            raise ValueError('A competing live-media service is not masked: ' + name)
    kernels = [p.name for p in (root / 'usr/lib/modules').iterdir() if p.is_dir()]
    if not kernels or any('.asahi.' not in k or '+16k' not in k for k in kernels):
        raise ValueError('The live media must use the Asahi 16 KiB kernel.')
    return kernels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('iso', 'identity', 'output'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    if (os.geteuid() != 0 or not (Path('/run/.containerenv').exists() or Path('/.dockerenv').exists()) or
            not stat.S_ISREG(args.iso.lstat().st_mode)):
        parser.error('Inspect a regular ISO in an isolated Linux builder.')
    identity = json.loads(args.identity.read_text())
    if (identity.get('kind') != 'harness-asahi-installer-media' or identity.get('published') is not False or
            identity.get('release_ready') is not False):
        parser.error('Use private media identity.')
    args.output.mkdir(parents=True, exist_ok=False)
    receipt = {'status': 'running', 'started_at': time.time(), 'media': identity,
               'scope': 'Actual ISO and compressed live root inspection; boot and hardware acceptance separate.'}
    def run(*command):
        result = subprocess.run(list(map(str, command)), check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        return result.stdout
    try:
        with tempfile.TemporaryDirectory(prefix='harness-media-inspect-') as tmp, ExitStack() as cleanup:
            iso, root = Path(tmp) / 'iso', Path(tmp) / 'root'
            iso.mkdir(); root.mkdir()
            run('mount', '-o', 'ro,loop', args.iso.resolve(), iso)
            cleanup.callback(run, 'umount', iso)
            squash = [p for p in iso.rglob('*') if p.name in ('squashfs.img', 'rootfs.squashfs')]
            if len(squash) != 1:
                raise ValueError('Expected one compressed live root.')
            run('mount', '-t', 'squashfs', '-o', 'ro,loop', squash[0], root)
            cleanup.callback(run, 'umount', root)
            receipt['kernels'] = inspect_root(root, identity)
            efi = [p for p in iso.rglob('*') if p.name.lower() == 'bootaa64.efi']
            if len(efi) != 1 or efi[0].stat().st_size < 1024:
                raise ValueError('The ARM UEFI fallback bootloader is missing.')
            receipt['uefi'] = {'path': str(efi[0].relative_to(iso)), 'sha256': digest(efi[0])}
            if list(iso.rglob('boot.bin')):
                raise ValueError('The USB must not provide m1n1/boot.bin.')
            inventory = run('chroot', root, 'rpm', '-qa', '--qf', '%{NAME}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n')
            (args.output / 'packages.tsv').write_text('\n'.join(sorted(inventory.splitlines())) + '\n')
        receipt['boot_layout'] = run('xorriso', '-indev', args.iso, '-report_el_torito', 'plain',
                                     '-report_system_area', 'plain')
        receipt.update(status='passed', artifact={'name': args.iso.name,
                       'bytes': args.iso.stat().st_size, 'sha256': digest(args.iso)})
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        receipt['completed_at'] = time.time()
        (args.output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
