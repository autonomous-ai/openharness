#!/usr/bin/env python3
"""Inspect the produced private ISO, including its actual compressed live root."""
import argparse
from contextlib import ExitStack
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import sys
import tempfile
import time

from asahi_image_check import digest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from asahi_media import policy_inventory


def efi_partition(document, image_bytes):
    """Use the GPT ESP that USB firmware reads, not the ISO9660 file mirror."""
    table = document.get('partitiontable', {})
    if table.get('label') != 'gpt' or table.get('unit') != 'sectors' or table.get('sectorsize') != 512:
        raise ValueError('Expected a hybrid ISO with a 512-byte GPT.')
    partitions = [p for p in table.get('partitions', [])
                  if p.get('type', '').lower() == 'c12a7328-f81f-11d2-ba4b-00a0c93ec93b']
    if len(partitions) != 1:
        raise ValueError('Expected exactly one EFI system partition.')
    part = partitions[0]
    start, size = part.get('start'), part.get('size')
    if (type(start) is not int or type(size) is not int or start < 64 or size < 2048 or
            (start + size) * 512 > image_bytes):
        raise ValueError('The EFI system partition is outside the image.')
    return {'offset': start * 512, 'bytes': size * 512}


def inspect_efi(esp):
    files = {}
    for relative in ('efi/boot/bootaa64.efi', 'efi/boot/grubaa64.efi', 'efi/boot/grub.cfg'):
        matches = [p for p in esp.rglob('*') if str(p.relative_to(esp)).lower() == relative]
        if len(matches) != 1 or matches[0].is_symlink() or not matches[0].is_file():
            raise ValueError('Missing or ambiguous EFI boot file: ' + relative)
        path = matches[0]
        content = path.read_bytes()
        if relative.endswith('.efi'):
            # PE/COFF Machine=ARM64, PE32+, Subsystem=EFI application. A file
            # called bootaa64.efi is not sufficient evidence of an ARM loader.
            offset = struct.unpack_from('<I', content, 0x3c)[0] if len(content) >= 64 else len(content)
            if (len(content) < 1024 or content[:2] != b'MZ' or offset + 94 > len(content) or
                    content[offset:offset + 4] != b'PE\0\0' or
                    struct.unpack_from('<H', content, offset + 4)[0] != 0xaa64 or
                    struct.unpack_from('<H', content, offset + 24)[0] != 0x20b or
                    struct.unpack_from('<H', content, offset + 92)[0] != 10):
                raise ValueError('Not an ARM64 EFI application: ' + relative)
        elif not content.strip():
            raise ValueError('Empty EFI boot configuration.')
        files[str(path.relative_to(esp))] = {'sha256': digest(path), 'bytes': path.stat().st_size}
    if list(esp.rglob('boot.bin')):
        raise ValueError('The USB must not provide m1n1/boot.bin.')
    return files


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
    if policy_inventory(root) != identity.get('selinux'):
        raise ValueError('The live policy differs from the verified installed image policy.')
    if (data / 'policy').exists():
        raise ValueError('The live root still contains temporary policy staging files.')
    if (root / 'boot/efi/m1n1/boot.bin').exists():
        raise ValueError('Removable media must not manage m1n1.')
    enabled = root / 'etc/systemd/system/multi-user.target.wants/harness-installer.service'
    if not enabled.is_symlink() or os.readlink(enabled) != '/usr/lib/systemd/system/harness-installer.service':
        raise ValueError('The installer does not start automatically.')
    preset = root / 'usr/lib/systemd/system-preset/00-harness-installer.preset'
    if preset.read_text().strip() != 'enable harness-installer.service':
        raise ValueError('First-boot presets must keep the installer enabled.')
    for name in ('getty@', 'serial-getty@', 'sshd', 'systemd-firstboot', 'first-boot', 'initial-setup',
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
    def run(*command, separate_errors=False):
        result = subprocess.run(list(map(str, command)), check=True, text=True,
                                stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE if separate_errors else subprocess.STDOUT, timeout=180)
        return result.stdout
    try:
        receipt['boot_layout'] = run('xorriso', '-indev', args.iso, '-report_el_torito', 'plain',
                                     '-report_system_area', 'plain')
        receipt['partition_table'] = json.loads(run('sfdisk', '--json', args.iso, separate_errors=True))
        partition = efi_partition(receipt['partition_table'], args.iso.stat().st_size)
        with tempfile.TemporaryDirectory(prefix='harness-media-inspect-') as tmp, ExitStack() as cleanup:
            iso, root, esp = (Path(tmp) / name for name in ('iso', 'root', 'esp'))
            iso.mkdir(); root.mkdir(); esp.mkdir()
            # Inspect these sequentially: mount refuses overlapping loop
            # mappings, and the kernel cannot mount a whole block device and
            # its partition at the same time even through a single mapping.
            with ExitStack() as efi_cleanup:
                options = f'ro,loop,offset={partition["offset"]},sizelimit={partition["bytes"]}'
                run('mount', '-t', 'vfat', '-o', options, args.iso.resolve(), esp)
                efi_cleanup.callback(run, 'umount', esp)
                receipt['uefi'] = {**partition, 'files': inspect_efi(esp)}
            run('mount', '-o', 'ro,loop', args.iso.resolve(), iso)
            cleanup.callback(run, 'umount', iso)
            receipt['iso_efi_paths'] = [str(p.relative_to(iso)) for p in iso.rglob('*')
                                        if p.name.lower() == 'bootaa64.efi']
            squash = [p for p in iso.rglob('*') if p.name in ('squashfs.img', 'rootfs.squashfs')]
            if len(squash) != 1:
                raise ValueError('Expected one compressed live root.')
            run('mount', '-t', 'squashfs', '-o', 'ro,loop', squash[0], root)
            cleanup.callback(run, 'umount', root)
            receipt['kernels'] = inspect_root(root, identity)
            if list(iso.rglob('boot.bin')):
                raise ValueError('The USB must not provide m1n1/boot.bin.')
            inventory = run('chroot', root, 'rpm', '-qa', '--qf', '%{NAME}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n')
            (args.output / 'packages.tsv').write_text('\n'.join(sorted(inventory.splitlines())) + '\n')
        receipt.update(status='passed', artifact={'name': args.iso.name,
                       'bytes': args.iso.stat().st_size, 'sha256': digest(args.iso)})
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        if isinstance(error, subprocess.CalledProcessError):
            receipt['command_failure'] = {'command': error.cmd, 'returncode': error.returncode,
                                           'output': error.stdout, 'stderr': error.stderr}
        raise
    finally:
        receipt['completed_at'] = time.time()
        (args.output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
