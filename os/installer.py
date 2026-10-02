#!/usr/bin/env python3
"""Offline full-disk installer. Nothing is erased until the exact disk is confirmed."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

MIN_DISK_BYTES = 12 * 1024**3


def run(*args, input=None, capture=False):
    result = subprocess.run([str(a) for a in args], input=input, check=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.decode().strip() if capture else None


def partitions(disk):
    separator = 'p' if disk[-1].isdigit() else ''
    return [f'{disk}{separator}{n}' for n in (1, 2, 3)]


def validate_config(config):
    if not isinstance(config, dict) or any(not isinstance(config.get(key), str) for key in ['username', 'hostname', 'password', 'disk']):
        raise ValueError('Account, computer, password and disk fields must be text.')
    if not re.fullmatch(r'[a-z_][a-z0-9_-]{0,30}', config.get('username', '')):
        raise ValueError('Use a Linux username: lowercase letters, digits, underscores or hyphens.')
    if config['username'] == 'root':
        raise ValueError('Create a regular user, not root.')
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', config.get('hostname', '')):
        raise ValueError('Invalid hostname.')
    password = config.get('password', '')
    if len(password) < 8 or any(c in password for c in '\r\n\0'):
        raise ValueError('Use a password of at least eight characters without line breaks.')
    if type(config.get('encrypt')) is not bool:
        raise ValueError('encrypt must be true or false.')
    if not re.fullmatch(r'/dev/[a-zA-Z0-9_-]+', config.get('disk', '')):
        raise ValueError('Select a whole /dev disk.')


def validate_disk(device, expected_serial=None):
    if device.get('type') != 'disk' or device.get('ro'):
        raise ValueError('Target must be a writable whole disk.')
    if int(device.get('size') or 0) < MIN_DISK_BYTES:
        raise ValueError('The target needs at least 12 GiB.')
    def mounted(node):
        return any(node.get('mountpoints') or []) or any(mounted(c) for c in node.get('children', []))
    if mounted(device):
        raise ValueError('The disk has mounted filesystems. The live USB and active disks cannot be erased.')
    if expected_serial is not None and str(device.get('serial') or '').strip() != expected_serial:
        raise ValueError('Disk serial does not match the unattended installation configuration.')


def inventory():
    return json.loads(run('lsblk', '--json', '--bytes', '--paths', '--output',
                          'NAME,TYPE,SIZE,RO,RM,MOUNTPOINTS,MODEL,SERIAL', capture=True))['blockdevices']


def selected_disk(config):
    devices = [d for d in inventory() if d['name'] == config['disk']]
    if len(devices) != 1:
        raise ValueError('Target disk was not found.')
    validate_disk(devices[0], config.get('expected_serial'))
    return devices[0]


def write(root, path, text, mode=0o644):
    target = root / path.lstrip('/')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    target.chmod(mode)


def chroot(root, *args, **kwargs):
    return run('arch-chroot', root, *args, **kwargs)


def validate_image_account(passwd, username):
    names = {line.split(':', 1)[0] for line in passwd.splitlines()}
    if username != 'programmer' and username in names:
        raise ValueError(f'The image reserves the username {username}; choose a different account name.')


def preflight(config, source):
    for command in ['sgdisk', 'udevadm', 'mkfs.fat', 'mkfs.btrfs', 'cryptsetup',
                    'mount', 'umount', 'btrfs', 'unsquashfs', 'arch-chroot', 'blkid']:
        if not shutil.which(command):
            raise ValueError(f'The installer is missing {command}. Boot an intact Programmer OS image.')
    validate_image_account(run('unsquashfs', '-cat', source, 'etc/passwd', capture=True), config['username'])
    lock = json.loads(run('unsquashfs', '-cat', source, 'usr/share/harness-os/lock.json', capture=True))
    if lock.get('architecture') != 'x86_64' or not lock.get('version'):
        raise ValueError('The source is not a Programmer OS x86_64 image.')
    kernel = json.loads(run('unsquashfs', '-cat', source, 'usr/share/harness-os/kernel.json', capture=True))
    if not re.fullmatch(r'usr/lib/modules/[a-zA-Z0-9._+-]+/vmlinuz', kernel.get('path', '')) or not re.fullmatch(r'[a-f0-9]{64}', kernel.get('sha256', '')):
        raise ValueError('The image has an invalid kernel manifest.')
    payload = subprocess.check_output(['unsquashfs', '-cat', str(source), kernel['path']])
    if hashlib.sha256(payload).hexdigest() != kernel['sha256']:
        raise ValueError('The installation kernel failed verification. No disk has been erased.')
    return kernel


def install(config, source, target):
    validate_config(config)
    # Inspect again immediately before partitioning, rather than trusting the picker.
    selected_disk(config)
    if not source.is_file():
        raise ValueError('Live system payload is missing; boot the Programmer OS USB.')
    if target.exists() and any(target.iterdir()):
        raise ValueError('Installation mountpoint is not empty.')
    if config.get('confirm_erase') != config['disk']:
        raise ValueError('Explicit confirmation of the exact disk is required.')
    kernel = preflight(config, source)
    selected_disk(config)
    started = time.monotonic()
    disk = config['disk']
    _, boot, root_partition = partitions(disk)
    target.mkdir(parents=True, exist_ok=True)
    mapper = f'hn-install-{os.getpid()}'
    opened = False
    mounted = False
    try:
        print(f'Erasing {disk} and installing Programmer OS...', flush=True)
        run('sgdisk', '--zap-all', disk)
        run('sgdisk', '-n', '1:1MiB:+2MiB', '-t', '1:ef02', '-c', '1:HN BIOS',
            '-n', '2:0:+1GiB', '-t', '2:ef00', '-c', '2:HN BOOT',
            '-n', '3:0:0', '-t', '3:8309' if config['encrypt'] else '3:8300', '-c', '3:HN ROOT', disk)
        run('udevadm', 'settle')
        run('mkfs.fat', '-F', '32', '-n', 'HNBOOT', boot)
        root_device = root_partition
        luks_uuid = None
        if config['encrypt']:
            secret = config['password'].encode()
            run('cryptsetup', 'luksFormat', '--type', 'luks2', '--batch-mode', '--key-file=-', root_partition, input=secret)
            run('cryptsetup', 'open', '--key-file=-', root_partition, mapper, input=secret)
            opened = True
            root_device = f'/dev/mapper/{mapper}'
            luks_uuid = run('blkid', '-s', 'UUID', '-o', 'value', root_partition, capture=True)
        run('mkfs.btrfs', '-f', '-L', 'HNROOT', root_device)
        run('mount', root_device, target)
        mounted = True
        for name in ('@', '@home', '@snapshots'):
            run('btrfs', 'subvolume', 'create', target / name)
        run('umount', target)
        mounted = False
        run('mount', '-o', 'subvol=@,compress=zstd:1,noatime', root_device, target)
        mounted = True
        for name, subvol in [('home', '@home'), ('.snapshots', '@snapshots')]:
            (target / name).mkdir()
            run('mount', '-o', f'subvol={subvol},compress=zstd:1,noatime', root_device, target / name)
        print('Copying the verified offline system...', flush=True)
        run('unsquashfs', '-f', '-no-progress', '-d', target, source)
        # Extract on Btrfs first: FAT cannot represent the image's Unix metadata.
        # Copy boot contents without that metadata before regenerating initramfs.
        boot_staging = target / 'boot.from-image'
        (target / 'boot').rename(boot_staging)
        (target / 'boot').mkdir()
        run('mount', boot, target / 'boot')
        for path in boot_staging.rglob('*'):
            destination = target / 'boot' / path.relative_to(boot_staging)
            if path.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            elif path.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
        shutil.rmtree(boot_staging)
        # mkarchiso moves the live /boot files out of SquashFS. Regenerate the
        # disk initramfs around this verified, package-owned kernel instead.
        shutil.copyfile(target / kernel['path'], target / 'boot/vmlinuz-linux-lts')
        print('Configuring account, boot and recovery...', flush=True)
        # The live image is immutable. No live passwords, SSH keys or sessions are copied.
        for path in ['etc/sudoers.d/10-live', 'etc/mkinitcpio.conf.d/archiso.conf',
                     'etc/systemd/system/serial-getty@ttyS0.service.d/live.conf',
                     'etc/pacman.d/hooks/99-harness-live.hook', 'root/setup-live.sh']:
            (target / path).unlink(missing_ok=True)
        for path in ['etc/systemd/system/getty@tty1.service.d', 'root/.ssh']:
            shutil.rmtree(target / path, ignore_errors=True)
        if (target / 'etc/passwd').read_text().find('\nprogrammer:') >= 0:
            chroot(target, 'userdel', '-r', 'programmer')
        chroot(target, 'useradd', '-m', '-G', 'wheel,video,audio', '-s', '/bin/bash', config['username'])
        chroot(target, 'chpasswd', input=f"{config['username']}:{config['password']}\n".encode())
        chroot(target, 'passwd', '-l', 'root')
        (target / 'var/lib/systemd/linger/programmer').unlink(missing_ok=True)
        write(target, f'/var/lib/systemd/linger/{config["username"]}', '')
        home = target / 'home' / config['username']
        (home / 'Projects').mkdir(exist_ok=True)
        chroot(target, 'chown', '-R', f"{config['username']}:{config['username']}", f"/home/{config['username']}")
        write(target, '/etc/sudoers.d/10-programmer', '%wheel ALL=(ALL:ALL) ALL\n', 0o440)
        write(target, '/etc/hostname', config['hostname'] + '\n')
        write(target, '/etc/hosts', f"127.0.0.1 localhost\n::1 localhost\n127.0.1.1 {config['hostname']}\n")
        write(target, '/etc/machine-id', '')
        write(target, '/etc/mkinitcpio.conf',
              'HOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole block sd-encrypt filesystems fsck)\nCOMPRESSION="zstd"\n')
        write(target, '/etc/vconsole.conf', 'KEYMAP=us\n')
        root_uuid = run('blkid', '-s', 'UUID', '-o', 'value', root_device, capture=True)
        boot_uuid = run('blkid', '-s', 'UUID', '-o', 'value', boot, capture=True)
        write(target, '/etc/fstab',
              f'UUID={root_uuid} / btrfs subvol=@,compress=zstd:1,noatime 0 0\n'
              f'UUID={root_uuid} /home btrfs subvol=@home,compress=zstd:1,noatime 0 0\n'
              f'UUID={root_uuid} /.snapshots btrfs subvol=@snapshots,compress=zstd:1,noatime 0 0\n'
              f'UUID={boot_uuid} /boot vfat umask=0077 0 2\n')
        # The disk-unlock password is the authentication step on encrypted installs.
        # Unencrypted installs require a normal console login instead of autologin.
        if config['encrypt']:
            write(target, '/etc/systemd/system/getty@tty1.service.d/autologin.conf',
                  '[Service]\nExecStart=\n' + f'ExecStart=-/usr/bin/agetty --autologin {config["username"]} --noclear %I $TERM\n')
        kernel_args = 'quiet loglevel=3 rootflags=subvol=@'
        if config.get('serial_console'):
            kernel_args += ' console=tty0 console=ttyS0,115200'
        if luks_uuid:
            kernel_args += f' rd.luks.name={luks_uuid}=cryptroot'
        write(target, '/etc/default/grub',
              'GRUB_DEFAULT=0\nGRUB_TIMEOUT=1\nGRUB_DISTRIBUTOR="Programmer OS"\n'
              'GRUB_DISABLE_OS_PROBER=true\n' + f'GRUB_CMDLINE_LINUX="{kernel_args}"\n')
        lock = json.loads((target / 'usr/share/harness-os/lock.json').read_text())
        snapshot = lock['arch_snapshot']
        write(target, '/etc/pacman.conf',
              '[options]\nArchitecture = auto\nCheckSpace\nSigLevel = Required DatabaseOptional\nLocalFileSigLevel = Optional\n'
              + ''.join(f'[{repo}]\nServer = https://archive.archlinux.org/repos/{snapshot}/$repo/os/$arch\n' for repo in ['core', 'extra']))
        # Retain network configuration explicitly, not the live user's home or credentials.
        networks = Path('/etc/NetworkManager/system-connections')
        if networks.exists():
            shutil.copytree(networks, target / 'etc/NetworkManager/system-connections', dirs_exist_ok=True)
        chroot(target, 'systemctl', 'enable', 'NetworkManager', 'systemd-resolved', 'systemd-timesyncd')
        chroot(target, 'systemctl', 'disable', 'sshd.service')
        chroot(target, '/usr/lib/harness-os/init-keyring')
        chroot(target, 'mkinitcpio', '-P')
        chroot(target, 'grub-install', '--target=i386-pc', '--recheck', disk)
        chroot(target, 'grub-install', '--target=x86_64-efi', '--efi-directory=/boot', '--boot-directory=/boot', '--removable', '--no-nvram')
        chroot(target, 'grub-mkconfig', '-o', '/boot/grub/grub.cfg')
        receipt = {'version': lock['version'], 'installed_at': datetime.now(timezone.utc).isoformat(),
                   'duration_seconds': round(time.monotonic() - started, 3), 'encrypted': config['encrypt'],
                   'disk_bytes': selected_size(config), 'root_uuid': root_uuid, 'boot_uuid': boot_uuid}
        write(target, '/var/lib/harness-os/install.json', json.dumps(receipt, indent=2) + '\n')
        run('sync')
        print(f"Installed in {receipt['duration_seconds']:.1f}s. Shut down, remove the USB, and boot the disk.", flush=True)
    finally:
        if mounted:
            run('umount', '-R', target)
        if opened:
            run('cryptsetup', 'close', mapper)


def selected_size(config):
    # After installation the target is mounted, so this is not a safety check.
    return next(int(d['size']) for d in inventory() if d['name'] == config['disk'])


def interactive():
    print('Programmer OS — offline installation\n')
    for d in inventory():
        if d['type'] == 'disk':
            print(f"{d['name']:16} {int(d['size']) / 1024**3:7.1f} GiB  {d.get('model', '')}  {d.get('serial', '')}")
    config = {'disk': input('\nInstall to whole disk: ').strip(),
              'username': input('Username [programmer]: ').strip() or 'programmer',
              'hostname': input('Computer name [programmer]: ').strip() or 'programmer',
              'encrypt': input('Encrypt the disk? [Y/n]: ').strip().lower() != 'n'}
    config['password'] = getpass.getpass('Account and disk-unlock password: ')
    if getpass.getpass('Repeat password: ') != config['password']:
        raise ValueError('Passwords do not match.')
    validate_config(config)
    disk = selected_disk(config)
    if disk.get('serial'):
        config['expected_serial'] = disk['serial'].strip()
    print(f"\nAll data on {disk['name']} ({disk.get('model', '')}, {disk.get('serial', '')}) will be erased.")
    config['confirm_erase'] = input(f"Type {disk['name']} to erase and install: ").strip()
    return config


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--yes-erase-disk', action='store_true')
    parser.add_argument('--source', type=Path, default=Path('/run/archiso/bootmnt/arch/x86_64/airootfs.sfs'))
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Run sudo hn-os install from the live USB.')
    if args.config:
        config = json.loads(args.config.read_text())
        if not args.yes_erase_disk or not config.get('expected_serial'):
            raise ValueError('Unattended installs require --yes-erase-disk and an exact expected_serial.')
    else:
        if args.yes_erase_disk:
            raise ValueError('--yes-erase-disk requires a configuration file.')
        config = interactive()
    install(config, args.source, Path('/mnt/harness-os'))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, KeyboardInterrupt) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        sys.exit(1)
