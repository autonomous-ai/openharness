#!/usr/bin/env python3
"""Encrypt/recover only the second cloned disk in the private Asahi test VM.

This is destructive fixture construction, not a user installer. The runner owns
both disks; the public fixture password must never appear in a released image.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path('/mnt/harness-encryption-test')
DEVICE = '/dev/vdb3'
MAPPER = 'harness-encryption-test'
PASSWORD = b'firstboot-local-42'
PROJECT = 'home/me/projects/encryption-check/result.txt'
PROJECT_TEXT = b'Harness encrypted project survives reboot and offline recovery.\n'


def run(*args, secret=None, timeout=120):
    result = subprocess.run(args, input=secret, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=timeout, check=False)
    text = result.stdout.decode(errors='replace')
    if result.returncode:
        raise RuntimeError(f'{args[0]} exited {result.returncode}: {text}')
    return text.strip()


def digest(path, count=None):
    result = hashlib.sha256()
    with open(path, 'rb') as stream:
        while count is None or count:
            data = stream.read(min(count, 1024**2) if count is not None else 1024**2)
            if not data:
                if count:
                    raise ValueError('Device ended before the declared byte count.')
                break
            result.update(data)
            if count is not None:
                count -= len(data)
    return result.hexdigest()


def leaked_mounts():
    current = os.readlink('/proc/self/ns/mnt')
    leaks = []
    for process in Path('/proc').glob('[0-9]*'):
        try:
            if os.readlink(process / 'ns/mnt') == current:
                continue
            for row in (process / 'mountinfo').read_text().splitlines():
                if row.split()[4] == str(ROOT):
                    leaks.append({'pid': int(process.name), 'mount': row})
        except (FileNotFoundError, ProcessLookupError):
            pass
    return leaks


def guard(source):
    if os.geteuid() != 0 or run('uname', '-m') != 'aarch64':
        raise ValueError('Use the owned native ARM maintenance VM.')
    if (os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt') or
            run('findmnt', '-nro', 'PROPAGATION', '/') != 'private'):
        raise ValueError('Run in unshare --mount --propagation private.')
    if run('findmnt', '-no', 'SOURCE', '/') != '/dev/vda':
        raise ValueError('The maintenance root must be the first disk.')
    if (run('lsblk', '-ndo', 'SERIAL', '/dev/vdb') != 'HARNESS_ENCRYPT_TEST' or
            run('blockdev', '--getss', '/dev/vdb') != '4096'):
        raise ValueError('The target is not the owned 4096-byte-sector clone.')
    table = json.loads(run('sfdisk', '--json', '/dev/vdb'))
    if [p['node'] for p in table['partitiontable']['partitions']] != ['/dev/vdb1', '/dev/vdb2', '/dev/vdb3']:
        raise ValueError('Unexpected target partitions.')
    if (run('lsblk', '-nro', 'MOUNTPOINTS', '/dev/vdb') or leaked_mounts() or
            Path('/dev/mapper', MAPPER).exists() or not re.fullmatch('[a-f0-9]{40}', source)):
        raise ValueError('The cloned target is in use or lacks its source identity.')
    return table


def identity(source):
    image = json.loads((ROOT / 'usr/share/harness-os/image.json').read_text())
    assert image['source_commit'] == source
    assert image['release_ready'] is False and image['kind'] == 'harness-asahi-image-construction'
    for name, expected in image['first_boot']['files'].items():
        assert digest(ROOT / name) == expected['sha256'], name
    for name, expected in image['session_package']['files'].items():
        assert digest(ROOT / name) == expected, name
    return image


def boot_configuration(uuid, result):
    crypttab = ROOT / 'etc/crypttab'
    assert not crypttab.exists() or not crypttab.read_text().strip()
    crypttab.write_text(f'harness-root UUID={uuid} none luks,x-initrd.attach\n')
    crypttab.chmod(0o600)
    # Name the root consistently in the initramfs and installed system. With
    # only rd.luks.uuid, a generic initramfs uses luks-UUID and the real root
    # attempts to open the same volume again under its crypttab name.
    arg = f'rd.luks.name={uuid}=harness-root'
    # QEMU's virt board defaults to a serial-only kernel console. Explicitly
    # select its graphical console so acceptance exercises actual key events.
    # These observer-only arguments are not additions to the produced image.
    consoles = 'console=ttyAMA0 console=tty0'
    added = arg + ' ' + consoles
    cmdline = ROOT / 'etc/kernel/cmdline'
    cmdline.write_text(cmdline.read_text().strip() + ' ' + added + '\n')
    grub = ROOT / 'etc/default/grub'
    content, count = re.subn(r'(?m)^GRUB_CMDLINE_LINUX_DEFAULT="([^"]*)"$',
                            lambda m: 'GRUB_CMDLINE_LINUX_DEFAULT="' + m[1] + ' ' + added + '"',
                            grub.read_text())
    assert count == 1
    grub.write_text(content)
    config = ROOT / 'etc/dracut.conf.d/20-harness-crypt.conf'
    config.write_text('add_dracutmodules+=" crypt "\n'
                     '# The acceptance VM uses a virtio keyboard, not Apple HID.\n'
                     'force_drivers+=" virtio_input "\n')
    run('chroot', str(ROOT), 'restorecon', '-F', '/etc/crypttab', '/etc/kernel/cmdline',
        '/etc/default/grub', '/etc/dracut.conf.d/20-harness-crypt.conf')
    run('chroot', str(ROOT), 'grubby', '--update-kernel=ALL', '--args=' + added)
    run('chroot', str(ROOT), 'grub2-mkconfig', '-o', '/boot/grub2/grub.cfg')
    kernels = [p.name for p in (ROOT / 'usr/lib/modules').iterdir() if p.is_dir() and (p / 'vmlinuz').is_file()]
    assert len(kernels) == 1
    initrd = '/boot/initramfs-' + kernels[0] + '.img'
    run('chroot', str(ROOT), 'dracut', '--force', '--no-hostonly', initrd, kernels[0], timeout=180)
    result['boot_entries'] = {p.name: p.read_text() for p in (ROOT / 'boot/loader/entries').glob('*.conf')}
    assert result['boot_entries'] and all(arg in value for value in result['boot_entries'].values())
    result['initramfs_modules'] = run('chroot', str(ROOT), 'lsinitrd', '-m', initrd)
    assert 'crypt' in result['initramfs_modules'] and 'kernel-modules-asahi' in result['initramfs_modules']
    contents = run('chroot', str(ROOT), 'lsinitrd', initrd)
    result['keyboard_modules'] = ['spi-hid-apple.ko', 'dockchannel-hid.ko', 'virtio_input.ko']
    assert all(name in contents for name in result['keyboard_modules'])
    result['observer_console_arguments'] = consoles
    result['observer_keyboard_driver'] = 'virtio_input'


def prepare(source, result):
    assert run('blkid', '-s', 'TYPE', '-o', 'value', DEVICE) == 'btrfs'
    run('mount', '-o', 'ro,rescue=nologreplay,subvol=root', DEVICE, str(ROOT))
    image = identity(source)
    assert not (ROOT / 'var/lib/harness-os/firstboot.json').exists()
    assert not any(1000 <= int(r.split(':')[2]) < 65534 for r in (ROOT / 'etc/passwd').read_text().splitlines())
    run('umount', str(ROOT))
    payload = int(run('blockdev', '--getsize64', DEVICE)) - 32 * 1024**2
    print('Preparing private LUKS2 root', flush=True)
    run('mount', '-o', 'subvol=root', DEVICE, str(ROOT))
    run('btrfs', 'filesystem', 'resize', str(payload), str(ROOT))
    run('umount', str(ROOT))
    result.update(plaintext_bytes=payload, plaintext_sha256=digest(DEVICE, payload))
    run('cryptsetup', 'reencrypt', '--encrypt', '--type', 'luks2', '--reduce-device-size', '32M',
        '--batch-mode', '--key-file', '-', '--init-only', DEVICE, secret=PASSWORD)
    run('cryptsetup', 'reencrypt', '--resume-only', '--key-file', '-', '--progress-json', DEVICE,
        secret=PASSWORD, timeout=300)
    uuid = run('cryptsetup', 'luksUUID', DEVICE)
    result['luks_uuid'] = uuid
    meta = json.loads(run('cryptsetup', 'luksDump', '--dump-json-metadata', DEVICE))
    assert all(s['type'] == 'crypt' for s in meta['segments'].values())
    assert not any('reencrypt' in json.dumps(s) for s in meta['keyslots'].values())
    run('cryptsetup', 'open', '--key-file', '-', DEVICE, MAPPER, secret=PASSWORD)
    assert digest('/dev/mapper/' + MAPPER, payload) == result['plaintext_sha256']
    result['plaintext_preserved'] = True
    run('mount', '-o', 'subvol=root', '/dev/mapper/' + MAPPER, str(ROOT))
    run('mount', '/dev/vdb2', str(ROOT / 'boot'))
    run('mount', '-o', 'ro', '/dev/vdb1', str(ROOT / 'boot/efi'))
    for name in ('dev', 'proc', 'sys', 'run'):
        run('mount', '--rbind', '/' + name, str(ROOT / name))
        run('mount', '--make-rslave', str(ROOT / name))
    assert not leaked_mounts(), 'Test mounts escaped into another namespace'
    boot_configuration(uuid, result)
    for name, expected in image['session_package']['files'].items():
        assert digest(ROOT / name) == expected, name
    run('sync')


def recover(source, result):
    assert run('blkid', '-s', 'TYPE', '-o', 'value', DEVICE) == 'crypto_LUKS'
    failed = subprocess.run(['cryptsetup', 'open', '--readonly', '--key-file', '-', DEVICE, MAPPER],
                            input=b'incorrect-fixture-password', capture_output=True, timeout=30)
    assert failed.returncode == 2 and not Path('/dev/mapper', MAPPER).exists()
    result['incorrect_password_rejected'] = True
    run('cryptsetup', 'open', '--readonly', '--key-file', '-', DEVICE, MAPPER, secret=PASSWORD)
    run('mount', '-o', 'ro,rescue=nologreplay,subvol=root', '/dev/mapper/' + MAPPER, str(ROOT))
    run('mount', '-o', 'ro,rescue=nologreplay,subvol=home', '/dev/mapper/' + MAPPER, str(ROOT / 'home'))
    identity(source)
    assert (ROOT / PROJECT).read_bytes() == PROJECT_TEXT
    result['project_sha256'] = digest(ROOT / PROJECT)
    result['readonly'] = run('blockdev', '--getro', '/dev/mapper/' + MAPPER) == '1'
    assert result['readonly'] and not leaked_mounts()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'recover'])
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    table = guard(args.source)
    state = Path('/var/tmp/harness-encryption-' + args.phase + '.json')
    if state.exists():
        raise ValueError('Use a fresh owned fixture for each preparation or recovery attempt.')
    ROOT.mkdir(exist_ok=True)
    assert not any(ROOT.iterdir())
    result = {'status': 'running', 'started_at': time.time(), 'phase': args.phase, 'source': args.source,
              'table': table, 'esp_sha256': digest('/dev/vdb1'), 'versions': run('rpm', '-q', 'cryptsetup', 'btrfs-progs')}
    try:
        try:
            (prepare if args.phase == 'prepare' else recover)(args.source, result)
        finally:
            # Never force removal or close a still-mounted filesystem. Private
            # propagation prevents service namespaces from retaining our mounts.
            if ROOT.is_mount():
                run('umount', '-R', str(ROOT))
            if Path('/dev/mapper', MAPPER).exists():
                run('cryptsetup', 'close', MAPPER, timeout=20)
        assert not leaked_mounts() and not Path('/dev/mapper', MAPPER).exists()
        assert table == json.loads(run('sfdisk', '--json', '/dev/vdb'))
        assert digest('/dev/vdb1') == result['esp_sha256']
        result.update(status='passed', mounts_isolated=True, mapping_closed=True)
    except BaseException as error:
        result.update(status='failed', error=str(error))
        raise
    finally:
        result['finished_at'] = time.time()
        state.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
