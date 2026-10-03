#!/usr/bin/env python3
"""Offline full-disk installer. Nothing is erased until the exact disk is confirmed."""
from __future__ import annotations
import argparse
import curses
from datetime import datetime, timezone
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
LIVE_PAYLOADS = (Path('/run/archiso/copytoram/airootfs.sfs'),
                 Path('/run/archiso/bootmnt/arch/x86_64/airootfs.sfs'))


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
    if not password:
        raise ValueError('Enter a password.')
    if any(c in password for c in '\r\n\0'):
        raise ValueError('The password cannot contain line breaks or null characters.')
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
    def live_medium(node):
        return (node.get('fstype') == 'iso9660' and node.get('label') == 'HN_OS') or any(
            live_medium(c) for c in node.get('children', []))
    if live_medium(device):
        raise ValueError('The Harness USB cannot be an installation target, even when booted into RAM.')
    if expected_serial is not None and str(device.get('serial') or '').strip() != expected_serial:
        raise ValueError('Disk serial does not match the unattended installation configuration.')


def inventory():
    return json.loads(run('lsblk', '--json', '--bytes', '--paths', '--output',
                          'NAME,TYPE,SIZE,RO,RM,MOUNTPOINTS,MODEL,SERIAL,FSTYPE,LABEL', capture=True))['blockdevices']


def live_payload(source=None):
    # Archiso automatically copies USB media to RAM when enough memory is free,
    # then unmounts bootmnt. Prefer that running image over any removable copy.
    candidates = (source,) if source is not None else LIVE_PAYLOADS
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    checked = ', '.join(str(path) for path in candidates)
    raise ValueError(f'Live system payload is missing (checked {checked}); boot the Harness USB.')


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
    if username != 'me' and username in names:
        raise ValueError(f'The image reserves the username {username}; choose a different account name.')


def preflight(config, source):
    for command in ['sgdisk', 'udevadm', 'mkfs.fat', 'mkfs.btrfs', 'cryptsetup',
                    'mount', 'umount', 'btrfs', 'unsquashfs', 'arch-chroot', 'blkid']:
        if not shutil.which(command):
            raise ValueError(f'The installer is missing {command}. Boot an intact Harness image.')
    validate_image_account(run('unsquashfs', '-cat', source, 'etc/passwd', capture=True), config['username'])
    lock = json.loads(run('unsquashfs', '-cat', source, 'usr/share/harness-os/lock.json', capture=True))
    if lock.get('architecture') != 'x86_64' or not lock.get('version'):
        raise ValueError('The source is not a Harness x86_64 image.')
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
        raise ValueError('Live system payload is missing; boot the Harness USB.')
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
        print(f'Erasing {disk} and installing Harness...', flush=True)
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
                     'etc/pacman.d/hooks/99-harness-live.hook', 'root/setup-live.sh', 'etc/harness-live']:
            (target / path).unlink(missing_ok=True)
        for path in ['etc/systemd/system/getty@tty1.service.d', 'root/.ssh']:
            shutil.rmtree(target / path, ignore_errors=True)
        if (target / 'etc/passwd').read_text().find('\nme:') >= 0:
            chroot(target, 'userdel', '-r', 'me')
        chroot(target, 'useradd', '-m', '-G', 'wheel,video,audio', '-s', '/bin/bash', config['username'])
        chroot(target, 'chpasswd', input=f"{config['username']}:{config['password']}\n".encode())
        chroot(target, 'passwd', '-l', 'root')
        (target / 'var/lib/systemd/linger/me').unlink(missing_ok=True)
        write(target, f'/var/lib/systemd/linger/{config["username"]}', '')
        home = target / 'home' / config['username']
        (home / 'Projects').mkdir(exist_ok=True)
        chroot(target, 'chown', '-R', f"{config['username']}:{config['username']}", f"/home/{config['username']}")
        write(target, '/etc/sudoers.d/10-harness', '%wheel ALL=(ALL:ALL) ALL\n', 0o440)
        write(target, '/etc/hostname', config['hostname'] + '\n')
        write(target, '/etc/hosts', f"127.0.0.1 localhost\n::1 localhost\n127.0.1.1 {config['hostname']}\n")
        write(target, '/etc/machine-id', '')
        write(target, '/etc/mkinitcpio.conf',
              'HOOKS=(base systemd autodetect microcode modconf kms keyboard sd-vconsole '
              + ('plymouth ' if config['encrypt'] else '')
              + 'block sd-encrypt filesystems fsck)\nCOMPRESSION="zstd"\n')
        write(target, '/etc/vconsole.conf', 'KEYMAP=us\n')
        if config['encrypt']:
            write(target, '/etc/plymouth/plymouthd.conf',
                  '[Daemon]\nTheme=harness\nShowDelay=0\nDeviceTimeout=5\n')
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
        # An encrypted root cannot appear until its owner returns to unlock it.
        # Do not send a person who paused at the prompt into emergency mode.
        root_flags = 'subvol=@' + (',x-systemd.device-timeout=0' if config['encrypt'] else '')
        kernel_args = f'quiet loglevel=3 rootflags={root_flags}'
        if config.get('serial_console'):
            kernel_args += ' console=tty0 console=ttyS0,115200 plymouth.ignore-serial-consoles'
        if luks_uuid:
            kernel_args += f' rd.luks.name={luks_uuid}=cryptroot splash'
        write(target, '/etc/default/grub',
              'GRUB_DEFAULT=0\nGRUB_TIMEOUT=1\nGRUB_DISTRIBUTOR="Harness"\n'
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


def display_text(value):
    # Device metadata must not inject terminal controls or extra form rows.
    return ''.join(c if c.isprintable() else '?' for c in str(value or '')).strip()


def disk_label(disk):
    size = f"{int(disk['size']) / 1_000_000_000:.1f}".removesuffix('.0')
    return f"{display_text(disk.get('model')) or 'Disk'}  {size} GB"


class InstallForm:
    """Small keyboard form using the Python/ncurses already in the image."""
    def __init__(self, screen, candidates, username, hostname, encrypt):
        self.screen, self.disks = screen, candidates
        self.username, self.hostname, self.encrypt = username, hostname, encrypt
        self.selected, self.focus = 0, 0
        self.passwords, self.positions = ['', ''], [0, 0]
        self.error = ''
        self.title = None
        self.cursor_visible = None

    def line(self, row, text, active=False, bold=False):
        height, width = self.screen.getmaxyx()
        if row >= height or width < 5:
            return
        attr = curses.A_REVERSE if active else curses.A_BOLD if bold else curses.A_NORMAL
        self.screen.addnstr(row, 2, text, width - 4, attr)

    def cursor(self, visible):
        if visible == self.cursor_visible:
            return
        try:
            curses.curs_set(int(visible))
        except curses.error:
            pass  # Some serial terminals cannot change cursor visibility.
        self.cursor_visible = visible

    def begin(self, title):
        if title != self.title:
            self.screen.clear()
            self.title = title
        else:
            self.screen.erase()
        height, width = self.screen.getmaxyx()
        if height < 18 or width < 54:
            self.cursor(False)
            self.line(0, 'Resize terminal to at least 54 columns and 18 rows.')
            self.line(2, 'Esc cancels. No disk has been changed.')
            self.screen.refresh()
            if self.key() == '\x1b':
                raise KeyboardInterrupt('Cancelled.')
            return False
        self.line(1, title, bold=True)
        return True

    def key(self):
        key = self.screen.get_wch()
        if key == '\x03':
            raise KeyboardInterrupt('Cancelled.')
        return key

    @staticmethod
    def enter(key):
        return key in ('\n', '\r', curses.KEY_ENTER)

    def pick_disk(self):
        selected = self.selected
        while True:
            if not self.begin('Select disk'):
                continue
            height, _ = self.screen.getmaxyx()
            count = max(1, height - 8)
            start = (selected // count) * count
            for index in range(start, min(start + count, len(self.disks))):
                disk = self.disks[index]
                row = 4 + index - start
                self.line(row, ('> ' if index == selected else '  ') + disk_label(disk) + '  ' + disk['name'], index == selected)
            self.cursor(False)
            self.screen.refresh()
            key = self.key()
            if key == '\x1b':
                return
            if self.enter(key):
                self.selected = selected
                return
            if key in (curses.KEY_UP, curses.KEY_BTAB):
                selected = (selected - 1) % len(self.disks)
            elif key in (curses.KEY_DOWN, '\t'):
                selected = (selected + 1) % len(self.disks)

    def edit_password(self, index, key):
        value, position = self.passwords[index], self.positions[index]
        if key in (curses.KEY_BACKSPACE, '\x7f', '\b') and position:
            value, position = value[:position - 1] + value[position:], position - 1
        elif key == curses.KEY_DC:
            value = value[:position] + value[position + 1:]
        elif key == '\x15':  # Ctrl+U clears a hidden field without revealing it.
            value, position = '', 0
        elif key == curses.KEY_LEFT:
            position = max(0, position - 1)
        elif key == curses.KEY_RIGHT:
            position = min(len(value), position + 1)
        elif key == curses.KEY_HOME:
            position = 0
        elif key == curses.KEY_END:
            position = len(value)
        elif isinstance(key, str) and key.isprintable() and len(value) < 4096:
            value, position = value[:position] + key + value[position:], position + len(key)
        self.passwords[index], self.positions[index] = value, position
        self.error = ''

    def run(self):
        self.screen.keypad(True)
        while True:
            if not self.begin('Install Harness'):
                continue
            disk = self.disks[self.selected]
            self.line(4, f"{'Disk':18}{disk_label(disk)}", self.focus == 0)
            self.line(6, f"{'Encryption':18}[{'x' if self.encrypt else ' '}]", self.focus == 1)
            capacity = min(32, self.screen.getmaxyx()[1] - 24)
            for index, label in enumerate(('Password', 'Repeat password')):
                position = self.positions[index]
                offset = max(0, position - capacity + 1)
                mask = '*' * len(self.passwords[index][offset:offset + capacity])
                self.line(8 + index * 2, f'{label:<18}[{mask:<{capacity}}]', self.focus == index + 2)
            self.line(12, self.error)
            self.line(14, f"{'':18}[ Install ]", self.focus == 4)
            self.line(16, 'All data on this disk will be erased.')
            self.cursor(self.focus in (2, 3))
            if self.focus in (2, 3):
                position = self.positions[self.focus - 2]
                self.screen.move(8 + (self.focus - 2) * 2, 21 + min(position, capacity - 1))
            self.screen.refresh()
            key = self.key()
            if key == '\x1b':
                raise KeyboardInterrupt('Cancelled.')
            if key in ('\t', curses.KEY_DOWN):
                self.focus = (self.focus + 1) % 5
            elif key in (curses.KEY_BTAB, curses.KEY_UP):
                self.focus = (self.focus - 1) % 5
            elif key == ' ' and self.focus == 1:
                self.encrypt = not self.encrypt
            elif self.enter(key):
                if self.focus == 0:
                    self.pick_disk()
                elif self.focus == 1:
                    self.encrypt = not self.encrypt
                elif self.focus in (2, 3):
                    self.focus += 1
                else:
                    config = dict(disk=disk['name'], username=self.username, hostname=self.hostname,
                                  encrypt=self.encrypt, password=self.passwords[0],
                                  expected_serial=str(disk.get('serial') or '').strip())
                    try:
                        validate_config(config)
                        if self.passwords[0] != self.passwords[1]:
                            raise ValueError('Passwords do not match.')
                        selected_disk(config)
                    except ValueError as error:
                        self.error = str(error)
                        continue
                    config['confirm_erase'] = disk['name']
                    return config
            elif self.focus in (2, 3):
                self.edit_password(self.focus - 2, key)


def interactive(username='me', hostname='harness', encrypt=True):
    candidates = []
    for disk in inventory():
        try:
            validate_disk(disk)
        except ValueError:
            continue
        candidates.append(disk)
    if not candidates:
        raise ValueError('No unmounted, writable whole disk of at least 12 GiB is available.')
    validate_config(dict(username=username, hostname=hostname, encrypt=encrypt,
                         disk=candidates[0]['name'], password='validation-only'))
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError('Interactive installation needs a terminal. Use --config for unattended installation.')
    curses.set_escdelay(25)
    return curses.wrapper(lambda screen: InstallForm(screen, candidates, username, hostname, encrypt).run())


def completion(screen):
    """Keep success visible when the installer owns an hn pane, then shut down on request."""
    screen.keypad(True)
    curses.flushinp()
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    selected = 0
    while True:
        screen.erase()
        height, width = screen.getmaxyx()
        rows = [(1, 'Harness is installed.', curses.A_BOLD),
                (4, 'Remove the USB after shutdown.', curses.A_NORMAL),
                (5, 'Then turn on this computer.', curses.A_NORMAL),
                (8, '[ Shut down ]', curses.A_REVERSE if selected == 0 else curses.A_NORMAL),
                (10, 'Back to Harness', curses.A_REVERSE if selected == 1 else curses.A_NORMAL)]
        for row, text, attr in rows:
            if row < height and width >= 5:
                screen.addnstr(row, 2, text, width - 4, attr)
        screen.refresh()
        key = screen.get_wch()
        if key in ('\x1b', '\x03'):
            return False
        if key in ('\t', curses.KEY_BTAB, curses.KEY_UP, curses.KEY_DOWN):
            selected = 1 - selected
        elif InstallForm.enter(key):
            return selected == 0


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--username', help='Override the default local account name (me)')
    parser.add_argument('--hostname', help='Override the default computer name (harness)')
    parser.add_argument('--no-encryption', action='store_true', help='Explicitly install without disk encryption')
    parser.add_argument('--yes-erase-disk', action='store_true')
    parser.add_argument('--source', type=Path, help='Override the automatically detected live system image')
    return parser.parse_args()


def main(args=None):
    args = arguments() if args is None else args
    if os.geteuid() != 0:
        raise SystemExit('Run sudo harness install from the live USB.')
    if args.config:
        if args.username is not None or args.hostname is not None or args.no_encryption:
            raise ValueError('With --config, set account names and encryption in that file instead of command-line overrides.')
        config = json.loads(args.config.read_text())
        if not args.yes_erase_disk or not config.get('expected_serial'):
            raise ValueError('Unattended installs require --yes-erase-disk and an exact expected_serial.')
        source = live_payload(args.source)
    else:
        if args.yes_erase_disk:
            raise ValueError('--yes-erase-disk requires a configuration file.')
        # Fail before collecting passwords if neither supported boot mode has
        # an image. An explicit missing --source never falls back silently.
        source = live_payload(args.source)
        config = interactive(username=args.username if args.username is not None else 'me',
                             hostname=args.hostname if args.hostname is not None else 'harness',
                             encrypt=not args.no_encryption)
    install(config, source, Path('/mnt/harness-os'))
    if not args.config:
        if curses.wrapper(completion):
            run('systemctl', 'poweroff')


def entrypoint():
    args = arguments()
    try:
        main(args)
    except KeyboardInterrupt:
        return 130
    except (ValueError, OSError, curses.error, subprocess.CalledProcessError) as error:
        print(f'Installation stopped: {error}', file=sys.stderr, flush=True)
        # An installer launched from the USB welcome owns its pane. Retain the
        # error until it has been read instead of closing the pane immediately.
        # Unattended configuration files and piped callers never wait for input.
        if not args.config and sys.stdin.isatty() and sys.stderr.isatty():
            try:
                input('Press Enter to return to Harness.')
            except (EOFError, KeyboardInterrupt):
                pass
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(entrypoint())
