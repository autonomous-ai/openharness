#!/usr/bin/env python3
"""Inspect the actual private Asahi disk image in an isolated Linux builder.

Read-only loop mounts cover the produced filesystems, not just KIWI's working
directory. This is image construction evidence, never Apple boot acceptance.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import tempfile
import time


PLATFORM_PACKAGES = (
    'kernel-16k-core', 'kernel-16k-modules', 'kernel-16k-modules-extra',
    'asahi-platform-metapackage', 'fedora-asahi-remix-scripts', 'asahi-fwupdate',
    'dracut-asahi', 'update-m1n1', 'uboot-images-armv8', 'grub2-efi-aa64',
    'asahi-audio', 'speakersafetyd', 'tiny-dfr', 'NetworkManager-wifi',
    'mesa-dri-drivers', 'greetd', 'chromium', 'harness-os-session',
)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def partition_layout(table, image_bytes):
    table = table['partitiontable']
    if table.get('label') != 'gpt' or table.get('unit') != 'sectors' or table.get('sectorsize') != 4096:
        raise ValueError('Expected Asahi GPT with 4096-byte sectors.')
    partitions = table['partitions']
    if len(partitions) != 3:
        raise ValueError('Expected only EFI, boot and root image partitions.')
    # Current KIWI assigns the Discoverable Partitions Specification types:
    # EFI, XBOOTLDR, then the native ARM64 root (not generic Linux data).
    expected_types = ('c12a7328-f81f-11d2-ba4b-00a0c93ec93b',
                      'bc13c2ff-59e6-4262-a352-b275fd6f7172',
                      'b921b045-1df0-41c3-af44-4c6f280d3fae')
    end = 2
    for row, expected in zip(partitions, expected_types):
        if (row['type'].lower() != expected or type(row['start']) is not int or
                type(row['size']) is not int or row['start'] < end or row['size'] <= 0 or
                (row['start'] + row['size']) * 4096 > image_bytes):
            raise ValueError('Unexpected, overlapping or out-of-bounds image partition.')
        end = row['start'] + row['size']
    return partitions


def inspect_root(root, boot, esp, identity, owner_uid=0):
    manifest = identity['session_package']
    if json.loads((root / 'usr/share/harness-os/image.json').read_text()) != identity:
        raise ValueError('The image lost its exact build/package provenance.')
    for relative, expected in manifest['files'].items():
        path = root / relative
        if path.is_symlink() or not path.is_file() or digest(path) != expected:
            raise ValueError('Actual image payload differs: ' + relative)
    for relative, expected in manifest['symlinks'].items():
        if os.readlink(root / relative) != expected:
            raise ValueError('Actual image link differs: ' + relative)
    first_boot = identity['first_boot']['files']
    if set(first_boot) != {'usr/lib/harness-os/firstboot.py',
                          'usr/lib/systemd/system/harness-firstboot.service',
                          'usr/lib/systemd/system-preset/01-harness-firstboot.preset'}:
        raise ValueError('Incomplete first-boot payload declaration.')
    for relative, expected in first_boot.items():
        path = root / relative
        if (path.is_symlink() or not path.is_file() or digest(path) != expected['sha256'] or
                stat.S_IMODE(path.stat().st_mode) != expected['mode'] or path.stat().st_uid != owner_uid):
            raise ValueError('Actual first-boot payload differs: ' + relative)
    enabled = root / 'etc/systemd/system/multi-user.target.wants/harness-firstboot.service'
    if not enabled.is_symlink() or os.readlink(enabled) != '/usr/lib/systemd/system/harness-firstboot.service':
        raise ValueError('Harness first boot is not enabled.')
    for target in ('graphical.target', 'multi-user.target'):
        if os.path.lexists(root / ('etc/systemd/system/' + target + '.wants/initial-setup.service')):
            raise ValueError('The competing account wizard is still enabled.')
    for name in ('var/lib/harness-os/firstboot.json', 'var/lib/harness-os/firstboot.done',
                 'var/lib/harness-os/session-setup.json', 'etc/reconfigSys'):
        if os.path.lexists(root / name):
            raise ValueError('The image has already entered account setup: ' + name)
    if (root / 'var/tmp/harness-image-input').exists():
        raise ValueError('Image still contains temporary builder inputs.')
    accounts = [row.split(':') for row in (root / 'etc/passwd').read_text().splitlines()]
    if any(1000 <= int(row[2]) < 65534 for row in accounts):
        raise ValueError('Image contains a pre-provisioned login account.')
    shadow = next(row.split(':') for row in (root / 'etc/shadow').read_text().splitlines() if row.startswith('root:'))
    if not shadow[1].startswith(('!', '*')):
        raise ValueError('Image contains an unlocked root account.')
    if (root / 'etc/machine-id').read_text().strip() not in ('', 'uninitialized'):
        raise ValueError('Image contains a fixed machine ID.')
    if (root / 'var/lib/systemd/random-seed').exists() or list((root / 'etc/ssh').glob('ssh_host_*_key')):
        raise ValueError('Image contains a machine-specific seed or SSH host key.')
    if not re.search(r'^SELINUX=enforcing$', (root / 'etc/selinux/config').read_text(), re.M):
        raise ValueError('Fedora SELinux policy is not enforcing.')
    if (root / 'etc/hostname').read_text().strip() != 'harness':
        raise ValueError('Image hostname differs.')
    boot_files = {'esp/m1n1/boot.bin': esp / 'm1n1/boot.bin',
                  'esp/EFI/BOOT/BOOTAA64.EFI': esp / 'EFI/BOOT/BOOTAA64.EFI'}
    kernels = list(boot.glob('vmlinuz-*'))
    initrds = list(boot.glob('initramfs-*'))
    if not kernels or not initrds:
        raise ValueError('The image is missing a kernel or initramfs.')
    for path in [*kernels, *initrds]:
        boot_files['boot/' + path.name] = path
    evidence = {}
    for relative, path in boot_files.items():
        if path.is_symlink() or not path.is_file() or path.stat().st_size < 1024:
            raise ValueError('Incomplete image boot file: ' + relative)
        evidence[relative] = {'bytes': path.stat().st_size, 'sha256': digest(path)}
    return evidence


@contextlib.contextmanager
def mounted_image(raw, temporary, run):
    loop = run('losetup', '--find', '--show', '--read-only', '--partscan', '--sector-size', '4096', raw).strip()
    if not re.fullmatch(r'/dev/loop[0-9]+', loop):
        raise ValueError('Unexpected image loop device: ' + loop)
    mounted = []
    try:
        folders = {}
        for label, number, options in [('esp', 1, 'ro'), ('boot', 2, 'ro,noload'),
                                        ('root', 3, 'ro,rescue=nologreplay,subvol=root')]:
            folder = temporary / label
            folder.mkdir()
            run('mount', '-o', options, loop + 'p' + str(number), folder)
            mounted.append(folder)
            folders[label] = folder
        yield folders
    finally:
        for folder in reversed(mounted):
            run('umount', folder)
        run('losetup', '--detach', loop)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--identity', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (platform.system() != 'Linux' or platform.machine() != 'aarch64' or os.geteuid() != 0 or
            not (Path('/run/.containerenv').is_file() or Path('/.dockerenv').is_file())):
        parser.error('Use an isolated, native ARM Linux image builder.')
    if args.image.is_symlink() or not stat.S_ISREG(args.image.stat().st_mode):
        parser.error('Read a regular image file, never a host disk.')
    raw = args.image.resolve()
    identity = json.loads(args.identity.read_text())
    if (identity.get('kind') != 'harness-asahi-image-construction' or
            identity.get('published') is not False or identity.get('release_ready') is not False):
        parser.error('Expected private image construction identity.')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'schema': 1, 'status': 'running', 'started_at': time.time(), 'image': identity,
               'scope': 'Produced disk filesystems and package/boot inputs; no boot or physical hardware test',
               'checks': []}
    with (output / 'commands.log').open('w') as log:
        def run(*command):
            log.write(json.dumps(list(map(str, command))) + '\n')
            log.flush()
            result = subprocess.run(list(map(str, command)), text=True, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, timeout=120)
            log.write(result.stdout)
            log.flush()
            result.check_returncode()
            return result.stdout
        try:
            table = json.loads(run('sfdisk', '--json', '--sector-size', '4096', raw))
            receipt['partitions'] = partition_layout(table, raw.stat().st_size)
            with tempfile.TemporaryDirectory(prefix='harness-asahi-inspect-') as temporary:
                with mounted_image(raw, Path(temporary), run) as mounts:
                    receipt['boot_files'] = inspect_root(mounts['root'], mounts['boot'], mounts['esp'], identity)
                    receipt['platform_packages'] = run('chroot', mounts['root'], 'rpm', '-q', *PLATFORM_PACKAGES).splitlines()
                    run('chroot', mounts['root'], 'rpm', '-V', 'harness-os-session')
                    inventory = run('chroot', mounts['root'], 'rpm', '-qa', '--qf',
                                    '%{NAME}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\t%{SIZE}\t%{SOURCERPM}\n')
                    (output / 'packages.tsv').write_text('\n'.join(sorted(inventory.splitlines())) + '\n')
                    receipt['checks'].extend([
                        'Actual EFI/ext4/Btrfs image partitions mounted read-only',
                        'Exact RPM-owned Harness/OpenCode payload and provenance',
                        'Asahi kernel, boot objects, firmware integration, audio safety and minimal graphical dependencies present',
                        'No login users, unlocked root, fixed machine identity, private keys or builder payload',
                        'SELinux enforcing policy retained',
                    ])
            receipt.update(status='passed', artifact={'name': raw.name, 'bytes': raw.stat().st_size,
                                                      'sha256': digest(raw)})
        except Exception as error:
            receipt.update(status='failed', error=str(error))
            raise
        finally:
            receipt['completed_at'] = time.time()
            (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
