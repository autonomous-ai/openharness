#!/usr/bin/env python3
"""Offline full-disk installer. Nothing is erased until the exact disk is confirmed."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
import curses
from datetime import datetime, timezone
import hashlib
import json
import os
import pwd
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

MIN_DISK_BYTES = 12 * 1024**3
LIVE_PAYLOADS = (Path('/run/archiso/copytoram/airootfs.sfs'),
                 Path('/run/archiso/bootmnt/arch/x86_64/airootfs.sfs'))
WORDMARK = ('█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀', '█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█')
COMMAND_LOG = None
INSTALL_LOG = Path('/var/log/harness-install.log')
LAST_LOG = None


def encryption_memory(meminfo=Path('/proc/meminfo')):
    """Budget Argon2 against RAM, not zram advertised as additional swap."""
    try:
        values = {name: int(value) for name, value in re.findall(
            r'^(MemTotal|MemAvailable):\s+(\d+) kB$', meminfo.read_text(), re.M)}
        total, available = values['MemTotal'], values['MemAvailable']
        if not 0 < available <= total:
            raise ValueError('Invalid memory information')
    except (OSError, KeyError, ValueError) as error:
        raise ValueError('Cannot check available memory for encryption. No disk has been erased.') from error
    # Cryptsetup normally uses at most half of physical RAM, up to 1 GiB.
    # Its extra free-memory limit applies only without swap. Zram is RAM too:
    # leave half of available RAM and at least 128 MiB for the live session.
    budget = min(1024 * 1024, total // 2, available // 2, available - 128 * 1024)
    budget = budget // 1024 * 1024
    if budget < 64 * 1024:
        raise ValueError('Not enough free memory for encryption. Close other harnesses and browser windows, then try again. No disk has been erased.')
    return budget


@contextmanager
def command_log(path):
    """Keep command output off the form. Never record stdin (which may be a password)."""
    global COMMAND_LOG
    previous = COMMAND_LOG
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as output:
            fd = None
            COMMAND_LOG = output
            yield output
    finally:
        COMMAND_LOG = previous
        if fd is not None:
            os.close(fd)


def run(*args, input=None, capture=False):
    if COMMAND_LOG:
        COMMAND_LOG.write('\n$ ' + shlex.join(str(a) for a in args) + '\n')
        COMMAND_LOG.flush()
    result = subprocess.run([str(a) for a in args], input=input, check=True,
                            stdout=subprocess.PIPE if capture else COMMAND_LOG,
                            stderr=COMMAND_LOG if capture else subprocess.STDOUT if COMMAND_LOG else None)
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
    payload = subprocess.check_output(['unsquashfs', '-cat', str(source), kernel['path']], stderr=COMMAND_LOG)
    if hashlib.sha256(payload).hexdigest() != kernel['sha256']:
        raise ValueError('The installation kernel failed verification. No disk has been erased.')
    return kernel


def trial_command(action, source, account, destination_fd=None):
    # Project paths are user-controlled. Read and write them without installer
    # privileges; a symlink/race must never let the installer copy a root secret.
    command = ['/usr/bin/python3', '/usr/lib/harness-os/trial_projects.py', action, str(source)]
    descriptors = ()
    if destination_fd is not None:
        command += ['--destination-fd', str(destination_fd)]
        descriptors = (destination_fd,)
    result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=COMMAND_LOG,
                            user=account.pw_uid, group=account.pw_gid, extra_groups=[],
                            pass_fds=descriptors, env={'PATH': '/usr/bin', 'LANG': 'C.UTF-8'})
    return json.loads(result.stdout)


def trial_source(config):
    if not Path('/etc/harness-live').is_file():
        return None
    account = pwd.getpwnam('me')
    source = Path(account.pw_dir) / 'Projects'
    if not source.exists():
        return None
    required = trial_command('size', source, account)['bytes']
    available = int(selected_disk(config)['size']) - 5 * 1024**3
    if required > available:
        raise ValueError('This disk needs more space for your trial projects. Choose a larger disk or save the projects elsewhere first.')
    return source, account


def preserve_trial(trial, target, home):
    if trial is None:
        return None
    source, account = trial
    # A root-owned parent keeps other live processes from changing the destination.
    # Only this child receives the open writable directory, then drops privileges.
    with tempfile.TemporaryDirectory(prefix='.harness-trial-', dir=target / 'home') as temp:
        staging = Path(temp) / 'Projects'
        staging.mkdir(mode=0o700)
        os.chown(staging, account.pw_uid, account.pw_gid)
        descriptor = os.open(staging, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            receipt = trial_command('copy', source, account, descriptor)
        finally:
            os.close(descriptor)
        shutil.rmtree(home / 'Projects')  # Only the new account's pristine skeleton.
        staging.rename(home / 'Projects')
    detail = home / '.local/state/harness-os/trial-projects.json'
    detail.parent.mkdir(parents=True, exist_ok=True)
    detail.write_text(json.dumps(receipt, indent=2) + '\n')
    detail.chmod(0o600)
    return {key: value for key, value in receipt.items() if key != 'entries'}


def install(config, source, target, progress=None):
    report = progress or (lambda message: print(message, flush=True))
    validate_config(config)
    # Inspect again immediately before partitioning, rather than trusting the picker.
    selected_disk(config)
    if not source.is_file():
        raise ValueError('Live system payload is missing; boot the Harness USB.')
    if target.exists() and any(target.iterdir()):
        raise ValueError('Installation mountpoint is not empty.')
    if config.get('confirm_erase') != config['disk']:
        raise ValueError('Explicit confirmation of the exact disk is required.')
    report('Checking installation files…')
    kernel = preflight(config, source)
    trial = trial_source(config)
    selected_disk(config)
    pbkdf_memory = encryption_memory() if config['encrypt'] else None
    started = time.monotonic()
    disk = config['disk']
    _, boot, root_partition = partitions(disk)
    target.mkdir(parents=True, exist_ok=True)
    mapper = f'hn-install-{os.getpid()}'
    opened = False
    mounted = False
    try:
        report('Preparing the disk…')
        run('sgdisk', '--zap-all', disk)
        run('sgdisk', '-n', '1:1MiB:+2MiB', '-t', '1:ef02', '-c', '1:HN BIOS',
            '-n', '2:0:+1GiB', '-t', '2:ef00', '-c', '2:HN BOOT',
            '-n', '3:0:0', '-t', '3:8309' if config['encrypt'] else '3:8300', '-c', '3:HN ROOT', disk)
        run('udevadm', 'settle')
        run('mkfs.fat', '-F', '32', '-n', 'HNBOOT', boot)
        root_device = root_partition
        luks_uuid = None
        if config['encrypt']:
            report('Setting up encryption…')
            secret = config['password'].encode()
            run('cryptsetup', 'luksFormat', '--type', 'luks2', '--batch-mode',
                '--pbkdf-memory', pbkdf_memory, '--key-file=-', root_partition, input=secret)
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
        report('Copying Harness…')
        # Unsquashfs defaults to 512 MiB of caches. Bound them so installation
        # still fits on a 1 GiB machine after trying the bundled agent/browser.
        run('unsquashfs', '-mem', '64M', '-f', '-no-progress', '-d', target, source)
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
        report('Setting up your account…')
        # The live image is immutable. Only Projects is transferred explicitly;
        # live account passwords, agent credentials, SSH keys and sessions stay out.
        for path in ['etc/sudoers.d/10-live', 'etc/mkinitcpio.conf.d/archiso.conf',
                     'etc/systemd/system/serial-getty@ttyS0.service.d/live.conf',
                     'etc/pacman.d/hooks/99-harness-live.hook', 'root/setup-live.sh']:
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
        if trial is not None:
            report('Keeping your trial projects…')
        trial_receipt = preserve_trial(trial, target, home)
        chroot(target, 'chown', '-Rh', f"{config['username']}:{config['username']}", f"/home/{config['username']}")
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
            # Keep the screen as /dev/console, as on an ordinary installation.
            # Making the diagnostic serial port primary can introduce serial-TTY
            # setup delays before Plymouth can display its unlock prompt.
            kernel_args += ' console=ttyS0,115200 console=tty0 plymouth.ignore-serial-consoles'
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
        report('Preparing startup and recovery…')
        chroot(target, '/usr/lib/harness-os/init-keyring')
        # Keep the live marker through this initial optional package transaction,
        # so recovery hooks do not checkpoint an unfinished installation.
        run('/usr/bin/python3', '/usr/lib/harness-os/hardware.py', 'configure-install', target)
        (target / 'etc/harness-live').unlink()
        chroot(target, 'mkinitcpio', '-P')
        chroot(target, 'grub-install', '--target=i386-pc', '--recheck', disk)
        chroot(target, 'grub-install', '--target=x86_64-efi', '--efi-directory=/boot', '--boot-directory=/boot', '--removable', '--no-nvram')
        chroot(target, 'grub-mkconfig', '-o', '/boot/grub/grub.cfg')
        receipt = {'version': lock['version'], 'installed_at': datetime.now(timezone.utc).isoformat(),
                   'duration_seconds': round(time.monotonic() - started, 3), 'encrypted': config['encrypt'],
                   'disk_bytes': selected_size(config), 'root_uuid': root_uuid, 'boot_uuid': boot_uuid}
        if pbkdf_memory is not None:
            receipt['pbkdf_memory_limit_kib'] = pbkdf_memory
        if trial_receipt is not None:
            receipt['trial_projects'] = trial_receipt
        write(target, '/var/lib/harness-os/install.json', json.dumps(receipt, indent=2) + '\n')
        report('Finishing installation…')
        run('sync')
        if progress is None:
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


def disk_label(disk, width=None):
    size = f"{int(disk['size']) / 1_000_000_000:.1f}".removesuffix('.0')
    model = display_text(disk.get('model')) or 'Disk'
    suffix = f'  {size} GB'
    if width is not None and len(model) + len(suffix) > width:
        model = model[:max(1, width - len(suffix) - 1)] + '…'
    return model + suffix


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
        self.top, self.left, self.width = 0, 2, 60
        self.accent = curses.A_BOLD
        try:
            if curses.has_colors():
                curses.start_color()
                curses.use_default_colors()
                curses.init_pair(1, curses.COLOR_YELLOW, -1)
                self.accent = curses.color_pair(1) | curses.A_BOLD
        except curses.error:
            pass

    def line(self, row, text, active=False, bold=False, accent=False):
        height, width = self.screen.getmaxyx()
        row += self.top
        if row >= height or width < 5:
            return
        attr = curses.A_REVERSE if active else self.accent if accent else curses.A_BOLD if bold else curses.A_NORMAL
        self.screen.addnstr(row, self.left, text, min(self.width, width - self.left - 1), attr)

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
        self.top, self.left, self.width = 0, 2, max(1, width - 4)
        if height < 18 or width < 54:
            self.cursor(False)
            self.line(0, 'Resize terminal to at least 54 columns and 18 rows.')
            self.line(2, 'Esc cancels. No disk has been changed.')
            self.screen.refresh()
            if self.key() == '\x1b':
                raise KeyboardInterrupt('Cancelled.')
            return False
        self.width = min(60, width - 4)
        self.left = (width - self.width) // 2
        self.top = max(0, (height - (22 if height >= 24 else 18)) // 2)
        if height >= 24:
            for row, word in enumerate(WORDMARK):
                self.line(row, word.center(self.width), accent=True)
            self.top += 4
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
            count = max(1, height - self.top - 7)
            start = (selected // count) * count
            for index in range(start, min(start + count, len(self.disks))):
                disk = self.disks[index]
                row = 4 + index - start
                name = display_text(disk['name'])
                label = disk_label(disk, self.width - len(name) - 4)
                self.line(row, ('> ' if index == selected else '  ') + label + '  ' + name, index == selected)
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
            # Identical models/capacities need a visible discriminator after selection.
            duplicate = sum(disk_label(d) == disk_label(disk) for d in self.disks) > 1
            suffix = '  ' + Path(disk['name']).name if duplicate else ''
            label = disk_label(disk, self.width - 18 - len(suffix)) + suffix
            self.line(4, f"{'Disk':18}{label}", self.focus == 0)
            self.line(6, f"{'Encryption':18}[{'x' if self.encrypt else ' '}]", self.focus == 1)
            capacity = min(32, self.width - 21)
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
                self.screen.move(self.top + 8 + (self.focus - 2) * 2,
                                 self.left + 19 + min(position, capacity - 1))
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
    view = InstallForm(screen, [], 'me', 'harness', True)
    view.cursor(False)
    selected = 0
    while True:
        if not view.begin('Harness is installed.'):
            continue
        view.line(4, 'Remove the USB after shutdown.')
        view.line(5, 'Then turn on this computer.')
        view.line(8, '[ Shut down ]', active=selected == 0)
        view.line(10, 'Back to Harness', active=selected == 1)
        screen.refresh()
        key = screen.get_wch()
        if key in ('\x1b', '\x03'):
            return False
        if key in ('\t', curses.KEY_BTAB, curses.KEY_UP, curses.KEY_DOWN):
            selected = 1 - selected
        elif InstallForm.enter(key):
            return selected == 0


def install_with_progress(screen, config, source, target):
    """A static text view: real stages, no invented percentage or extra process."""
    view = InstallForm(screen, [], config['username'], config['hostname'], config['encrypt'])
    view.cursor(False)

    def render(message):
        # A resize must never pause a disk operation waiting for keyboard input.
        screen.erase()
        height, width = screen.getmaxyx()
        view.width = max(1, min(60, width - 4))
        view.left = max(0, (width - view.width) // 2)
        view.top = max(0, (height - 12) // 2)
        if height >= 18:
            for row, word in enumerate(WORDMARK):
                view.line(row, word.center(view.width), accent=True)
            view.top += 4
        view.line(1, 'Installing Harness', bold=True)
        view.line(4, message)
        view.line(6, 'Keep this computer powered on.')
        screen.refresh()

    def progress(message):
        if COMMAND_LOG:
            COMMAND_LOG.write('\n' + message + '\n')
            COMMAND_LOG.flush()
        try:
            render(message)
        except curses.error:
            # A display resize or lost terminal is not a reason to interrupt a
            # disk transaction. Its diagnostics and final status are retained.
            pass

    global LAST_LOG
    with command_log(INSTALL_LOG):
        LAST_LOG = INSTALL_LOG
        install(config, source, target, progress=progress)


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
    if args.config:
        install(config, source, Path('/mnt/harness-os'))
    else:
        curses.wrapper(lambda screen: install_with_progress(screen, config, source, Path('/mnt/harness-os')))
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
        if not args.config and LAST_LOG is not None:
            print(f'Details: {LAST_LOG}', file=sys.stderr, flush=True)
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
