#!/usr/bin/python3
"""Private Asahi installer UI. Use only space prepared by the Asahi installer.

Media supplies the read-only payload and its immutable identity. This command
never selects or erases a whole disk and is not an Apple boot-policy installer.
"""
import argparse
from contextlib import contextmanager
import curses
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import platform
import stat
import subprocess
import sys
import textwrap

spec = importlib.util.spec_from_file_location('asahi_startup', Path(__file__).with_name('startup.py'))
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)
storage, target = startup.storage, startup.target
WORDMARK = ('█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀', '█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█')
RECORD = Path('asahi/harness-install/target.json')
LOG = Path('/var/log/harness-asahi-install.log')


def validate_password(password, repeat):
    if not password:
        raise ValueError('Enter a password.')
    if any(c in password for c in '\n\r\0'):
        raise ValueError('Use a password without line breaks.')
    if password != repeat:
        raise ValueError('Passwords do not match.')


def verify_destination(plan):
    """Read-only recheck before presenting or committing the selected space."""
    target.validate_plan(plan)
    device = plan['original']['device']
    esp = target.platform_esp()
    if esp != plan['esp_uuid'] or target.owning_disk(target.inventory(), esp) != device:
        raise target.TargetError('This space belongs to another Asahi installation.')
    fd = os.open(device, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if (not stat.S_ISBLK(os.fstat(fd).st_mode) or
                target.command('blockdev', '--getss', device) != '4096' or
                target.command('blockdev', '--getro', device) != '0'):
            raise target.TargetError('Use the writable internal Asahi disk.')
        target.lock_disk(fd)
        snapshot = target.read_table(device)
        target.verify_gpt(fd, int(target.command('blockdev', '--getsize64', device)), target.normalize(snapshot))
        target.remaining(plan, snapshot)
        nodes = {part['node'] for part in plan['additions']}
        inventory = json.loads(target.command('lsblk', '--json', '--paths', '--output', 'NAME,MOUNTPOINTS', device))
        def mounted(entry):
            return any(entry.get('mountpoints') or []) or any(mounted(c) for c in entry.get('children', []))
        for entry in inventory['blockdevices']:
            for part in entry.get('children', []):
                if part['name'] in nodes and mounted(part):
                    raise target.TargetError('The installed system is in use. Start from installer media.')
    finally:
        os.close(fd)


@contextmanager
def destination():
    """Inspect the firmware-owned ESP read-only; cancellation writes nothing."""
    if (platform.system() != 'Linux' or os.geteuid() != 0 or
            os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt') or
            target.command('findmnt', '-nro', 'PROPAGATION', '/') != 'private'):
        raise target.TargetError('Start the installer in its private Linux mount namespace.')
    esp = target.platform_esp()
    disk = target.owning_disk(target.inventory(), esp)
    table = target.normalize(target.read_table(disk))
    part = next(p for p in table['partitions'] if p['uuid'] == esp)
    if part['type'] != target.EFI:
        raise target.TargetError('The Asahi boot partition has changed.')
    with storage.work_directory() as work:
        with storage.mounted(part['node'], work / 'esp', 'ro,noatime,uid=0,gid=0,fmask=0177,dmask=0077') as root:
            path = root / RECORD
            plan = target.load_plan(path) if os.path.lexists(path) else target.new_plan(
                {'partitiontable': {**table, 'label': 'gpt', 'unit': 'sectors'}}, esp)
            verify_destination(plan)
            yield root, plan


def install(root, plan, payload, password, progress):
    validate_password(password, password)
    progress('Checking installation files…')
    # An invalid source must not even create destination partitions or a receipt.
    with payload.open():
        verify_destination(plan)
    progress('Preparing storage…')
    storage.run('mount', '-o', 'remount,rw', root)
    path = root / RECORD
    if os.path.lexists(path):
        if target.load_plan(path) != plan:
            raise target.TargetError('The installation plan changed. Keep it for recovery.')
    else:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.save_plan(path, plan)
    target.apply_plan(path)
    storage.install(path, payload, password, progress=progress)
    progress('Preparing startup…')
    def phase(value):
        progress({'boot': 'Setting up your account…', 'account': 'Finishing installation…',
                  'complete': 'Harness is installed.'}[value])
    state = startup.finish(path, payload, password, progress=phase)
    if state['phase'] != 'complete':
        raise storage.StorageError('Installation has not finished. Start the installer again to continue.')
    storage.run('sync', '-f', root)
    return state


def diagnostic(error):
    fd = os.open(LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(type(error).__name__ + ': ' + str(error) + '\n')


class Page:
    """One terminal page: prepared space, two hidden fields, one install action."""
    def __init__(self, screen):
        self.screen = screen
        self.values, self.positions, self.focus = ['', ''], [0, 0], 0
        self.error = ''
        self.accent, self.idle, self.active = curses.A_BOLD, curses.A_REVERSE, curses.A_REVERSE
        self.palette = []
        self.hits = []
        screen.keypad(True)
        try:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_YELLOW, -1)
            idle, active = (250, 255) if curses.COLORS >= 256 else (curses.COLOR_WHITE, curses.COLOR_WHITE)
            if curses.COLORS < 256 and curses.can_change_color():
                # The Linux console exposes eight colors. Bold black becomes
                # gray rather than making a background brighter. Reserve two
                # palette entries so focus is black-on-white, never gray-on-gray.
                idle, active = curses.COLOR_CYAN, curses.COLOR_WHITE
                for color, level in ((idle, 700), (active, 1000)):
                    self.palette.append((color, *curses.color_content(color)))
                    curses.init_color(color, level, level, level)
            curses.init_pair(2, curses.COLOR_BLACK, idle)
            curses.init_pair(3, curses.COLOR_BLACK, active)
            self.accent |= curses.color_pair(1)
            self.idle, self.active = curses.color_pair(2), curses.color_pair(3)
            curses.mousemask(curses.BUTTON1_CLICKED | curses.BUTTON1_RELEASED)
        except curses.error:
            pass

    def close(self):
        for entry in reversed(self.palette):
            try:
                curses.init_color(*entry)
            except curses.error:
                pass

    def line(self, row, text, *, offset=0, width=None, attr=0):
        height, columns = self.screen.getmaxyx()
        y, x = self.top + row, self.left + offset
        limit = min(self.width - offset if width is None else width, columns - x - 1)
        if 0 <= y < height and 0 <= x < columns - 1 and limit > 0:
            self.screen.addnstr(y, x, text, limit, attr)

    def render(self, storage_label='', status=None, done=False):
        self.screen.erase()
        height, columns = self.screen.getmaxyx()
        self.width = min(60, max(1, columns - 4))
        self.left, self.top = max(0, (columns - self.width) // 2), max(0, height // 2 - 7)
        self.hits = []
        for row, word in enumerate(WORDMARK):
            self.line(row, word.center(self.width), attr=self.accent)
        usable = columns >= 54 and height >= 18
        if status is not None:
            for row, text in enumerate(textwrap.wrap(status, min(48, self.width))):
                self.line(5 + row, text.center(self.width))
            if done:
                self.button(9, 'Shut down', 2, compact=True)
        elif not usable:
            self.line(5, 'Resize to 54 columns and 18 rows.')
        else:
            self.line(4, 'Disk')
            self.line(4, storage_label, offset=18)
            self.line(6, 'Encryption')
            self.line(6, '[x]', offset=18)
            capacity = self.width - 20
            for index, label in enumerate(('Password', 'Repeat password')):
                row = 8 + index * 2
                position = self.positions[index]
                start = max(0, position - capacity + 1)
                mask = '*' * len(self.values[index][start:start + capacity])
                self.line(row, label)
                self.line(row, (' ' + mask).ljust(self.width - 18), offset=18,
                          attr=self.active if self.focus == index else 0)
                self.hits.append((self.top + row, self.left + 18, self.left + self.width, index))
            for row, text in enumerate(self.error.splitlines()[:2]):
                self.line(12 + row, text)
            self.button(14, 'Install Harness', 2)
        try:
            editing = usable and status is None and self.focus < 2
            curses.curs_set(int(editing))
            if editing:
                self.screen.move(self.top + 8 + self.focus * 2,
                                 self.left + 19 + min(self.positions[self.focus], self.width - 21))
        except curses.error:
            pass
        self.screen.refresh()
        return usable

    def button(self, row, text, index, compact=False):
        label = '[ ' + text + ' ]' if compact else text
        width = len(label) if compact else self.width
        offset = (self.width - width) // 2
        self.line(row, label.center(width), offset=offset, width=width,
                  attr=self.active if self.focus == index or compact else self.idle)
        self.hits.append((self.top + row, self.left + offset, self.left + offset + width, index))

    def edit(self, key):
        i = self.focus
        value, position = self.values[i], self.positions[i]
        if key in ('\b', '\x7f', curses.KEY_BACKSPACE) and position:
            value, position = value[:position - 1] + value[position:], position - 1
        elif key == curses.KEY_DC:
            value = value[:position] + value[position + 1:]
        elif key == '\x15':
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
        self.values[i], self.positions[i], self.error = value, position, ''

    def key(self):
        key = self.screen.get_wch()
        if key == curses.KEY_MOUSE:
            try:
                _, x, y, _, buttons = curses.getmouse()
                if buttons & (curses.BUTTON1_CLICKED | curses.BUTTON1_RELEASED):
                    for row, first, end, index in self.hits:
                        if y == row and first <= x < end:
                            self.focus = index
                            return '\n' if index == 2 else None
            except curses.error:
                pass
        return key

    def password(self, label):
        while True:
            usable = self.render(label)
            key = self.key()
            if key in ('\x1b', '\x03'):
                self.values = ['', '']
                return None
            if not usable:
                continue
            if key in ('\t', curses.KEY_DOWN):
                self.focus = (self.focus + 1) % 3
            elif key in (curses.KEY_UP, curses.KEY_BTAB):
                self.focus = (self.focus - 1) % 3
            elif key in ('\r', '\n', curses.KEY_ENTER):
                if self.focus < 2:
                    self.focus += 1
                else:
                    try:
                        validate_password(*self.values)
                        password = self.values[0]
                        self.values, self.positions = ['', ''], [0, 0]
                        return password
                    except ValueError as error:
                        self.error = str(error)
            elif self.focus < 2:
                self.edit(key)

    def progress(self, message):
        try:
            self.render(status=message)
        except curses.error:
            pass  # Resizing or losing the display must not interrupt disk work.

    def complete(self):
        curses.flushinp()
        message = 'Harness is installed. Shut down, remove the USB, then turn on your computer.'
        while True:
            self.render(status=message, done=True)
            if self.key() in ('\r', '\n', curses.KEY_ENTER):
                try:
                    storage.run('systemctl', 'poweroff')
                    return
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    diagnostic(error)
                    message = 'Harness is installed. Could not shut down. Try again.'


def application(screen, payload):
    curses.raw()
    view = Page(screen)
    try:
        with destination() as (root, plan):
            size = sum(p['size'] for p in plan['additions']) * 4096 / 1024**3
            label = f'{Path(plan["original"]["device"]).name} · {size:.1f} GiB prepared'
            while True:
                password = view.password(label)
                if password is None:
                    return
                try:
                    install(root, plan, payload, password, view.progress)
                    break
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    diagnostic(error)
                    view.error, view.focus = 'Installation stopped. Details:\n' + str(LOG), 0
                finally:
                    password = None
        # Unmount the ESP before reporting success or asking the computer to stop.
        view.complete()
    finally:
        view.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-device', required=True, help='Read-only raw image device supplied by installer media')
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--image-source', required=True)
    args = parser.parse_args()
    if platform.system() != 'Linux' or os.geteuid() != 0:
        parser.error('Start from the private Harness Asahi installer media.')
    payload = storage.Payload(args.source_device, args.sha256, args.image_source)
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.error('The installer needs a terminal.')
    if os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt'):
        os.execv('/usr/bin/unshare', ['unshare', '--mount', '--propagation', 'private',
                                   '/usr/bin/python3', str(Path(__file__).resolve()), *sys.argv[1:]])
    lock = os.open('/run/harness-asahi-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        target.private_file(lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        curses.set_escdelay(25)
        curses.wrapper(lambda screen: application(screen, payload))
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
