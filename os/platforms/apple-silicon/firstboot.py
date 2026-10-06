#!/usr/bin/python3
"""First local account for a pristine, private Harness Asahi image only.

The session RPM never provisions users. This image-owned step uses Fedora's
account tools, keeps root locked and hands login to the existing greetd setup.
Its durable receipt contains identity and progress, never a password or hash.
"""
import curses
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import uuid


def sibling(name):
    spec = importlib.util.spec_from_file_location('harness_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


session = sibling('fedora_session')
STATE = 'var/lib/harness-os/firstboot.json'
DONE = 'var/lib/harness-os/firstboot.done'
WORDMARK = ('█ █ ▄▀█ █▀█ █▄ █ █▀▀ █▀ █▀', '█▀█ █▀█ █▀▄ █ ▀█ ██▄ ▄█ ▄█')


class FirstBoot(session.Setup):
    def image(self):
        image = json.loads(self.path('usr/share/harness-os/image.json').read_text())
        release = self.path('etc/os-release').read_text()
        if (os.geteuid() != 0 or platform.machine() != 'aarch64' or
                not re.search(r'^ID=[\"\']?fedora-asahi-remix[\"\']?$', release, re.M) or
                image.get('kind') != 'harness-asahi-image-construction' or
                image.get('profile') != 'Harness' or image.get('release_ready') is not False or
                not re.fullmatch(r'[a-f0-9]{40}', str(image.get('source_commit')))):
            raise session.SetupError('This setup belongs to the private Harness Mac image.')
        return image['source_commit']

    def read_state(self):
        entry = self.snapshot(STATE)
        if entry is None:
            return None
        if entry['kind'] != 'file' or entry['mode'] != 0o600:
            raise session.SetupError('The first-boot receipt is not a private regular file.')
        state = json.loads(entry['text'])
        if (set(state) != {'schema', 'source', 'token', 'phase'} or state['schema'] != 1 or
                state['source'] != self.image() or
                not re.fullmatch(r'[a-f0-9]{32}', str(state['token'])) or
                state['phase'] not in {'account', 'password', 'complete'}):
            raise session.SetupError('The first-boot receipt has changed. Preserve it for recovery.')
        return state

    def save_state(self, state):
        self.write(STATE, session.regular(json.dumps(state, indent=2) + '\n', 0o600), replace=True)

    def records(self, name):
        return [row.split(':') for row in self.path('etc/' + name).read_text().splitlines()]

    def identity(self, state=None):
        accounts = self.records('passwd')
        root = next(row for row in self.records('shadow') if row[0] == 'root')
        if not root[1].startswith(('!', '*')):
            raise session.SetupError('Keep the existing root authentication policy; setup cannot continue.')
        user = next((row for row in accounts if row[0] == 'me'), None)
        groups = self.records('group')
        group = next((row for row in groups if row[0] == 'me' or row[2] == '1000'), None)
        if any(1000 <= int(row[2]) < 65534 and row[0] != 'me' for row in accounts):
            raise session.SetupError('This computer already has an account. Keep its existing setup.')
        if state is None:
            if user or group or os.path.lexists(self.root / 'home/me') or self.load():
                raise session.SetupError('This computer already has account or login settings.')
        else:
            expected = ['me', 'x', '1000', '1000', 'Harness setup ' + state['token'], '/home/me', '/bin/bash']
            if state['phase'] == 'complete' and user and user[4] == 'me':
                expected[4] = 'me'
            if user is not None and user != expected:
                raise session.SetupError('The local account differs from this setup. Keep it unchanged.')
            if group is not None and group not in (['me', 'x', '1000', ''], ['me', 'x', '1000', 'me']):
                raise session.SetupError('The local group differs from this setup. Keep it unchanged.')
            if state['phase'] != 'account' and user is None:
                raise session.SetupError('The account created by setup is missing.')
        return user, group

    def prepare(self):
        source = self.image()
        state = self.read_state()
        self.identity(state)
        if state is None:
            self.run('/usr/sbin/visudo', '-c')
            state = {'schema': 1, 'source': source, 'token': uuid.uuid4().hex, 'phase': 'account'}
            self.save_state(state)  # Before creating an account, group or home.
        return state

    def ensure_home(self, state):
        home = self.root / 'home/me'
        # Check /home independently: the final directory is intentionally user-owned.
        self.path('home/.harness-firstboot-parent-check')
        if os.path.lexists(home):
            info = home.lstat()
            if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (1000, 1000, 0o700):
                raise session.SetupError('The account home differs from this setup. Keep it unchanged.')
            return
        staging = self.path('home/.harness-firstboot-' + state['token'])
        if staging.exists():
            info = staging.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
                raise session.SetupError('The temporary home is not securely owned.')
            shutil.rmtree(staging)  # Only this receipt's inaccessible, unfinished copy.
        staging.mkdir(mode=0o700)
        new = staging / 'home'
        shutil.copytree(self.path('etc/skel'), new, symlinks=True)
        for path in [*new.rglob('*'), new]:
            os.chown(path, 1000, 1000, follow_symlinks=False)
        new.chmod(0o700)
        self.run('/usr/bin/sync', '-f', str(staging))
        os.rename(new, home)
        self.sync_directory(home.parent)
        staging.rmdir()
        self.run('/usr/sbin/restorecon', '-RF', str(home))

    @staticmethod
    def validate_password(password, repeat):
        if not password:
            raise ValueError('Enter a password.')
        if any(char in password for char in '\n\r\0'):
            raise ValueError('Use a password without line breaks.')
        if password != repeat:
            raise ValueError('Passwords do not match.')

    def set_password(self, password):
        # Neither process arguments, logs, receipts nor temporary files carry it.
        result = subprocess.run(['/usr/sbin/chpasswd'], input='me:' + password + '\n',
                                text=True, capture_output=True, timeout=20)
        if result.returncode:
            raise session.SetupError('Could not set the password. Try another password.')

    def provision(self, state, password):
        if state['phase'] != 'account':
            raise session.SetupError('This account already has its password. Continue setup instead.')
        self.validate_password(password, password)
        user, group = self.identity(state)
        if not group:
            self.run('/usr/sbin/groupadd', '--gid', '1000', 'me')
        if not user:
            self.run('/usr/sbin/useradd', '--no-create-home', '--uid', '1000', '--gid', '1000',
                     '--groups', 'wheel', '--home-dir', '/home/me', '--shell', '/bin/bash',
                     '--comment', 'Harness setup ' + state['token'], 'me')
        self.identity(state)
        self.ensure_home(state)
        self.set_password(password)
        self.run('/usr/bin/sync', '-f', str(self.root / 'etc/shadow'))
        state['phase'] = 'password'
        self.save_state(state)

    def finish(self, state):
        self.identity(state)
        if state['phase'] == 'account':
            raise session.SetupError('Set the account password before starting Harness.')
        previous = self.load()
        if previous and previous['phase'] != 'enabled':
            # Restore only a matching, interrupted transaction from our existing
            # session helper. Its verifier rejects administrator modifications.
            if previous['user'] != 'me' or previous['uid'] != 1000:
                raise session.SetupError('Keep the existing login configuration.')
            self.disable()
        self.enable('me')
        state['phase'] = 'complete'
        self.save_state(state)
        self.run('/usr/sbin/usermod', '--comment', 'me', 'me')
        self.write(DONE, session.regular('me@harness\n', 0o600), replace=True)


class PasswordPage:
    def __init__(self, screen):
        self.screen = screen
        self.values = ['', '']
        self.focus = 0
        self.error = ''
        self.accent = curses.A_BOLD
        try:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_YELLOW, -1)
            self.accent |= curses.color_pair(1)
        except curses.error:
            pass
        screen.keypad(True)

    def render(self, status=None):
        self.screen.erase()
        height, width = self.screen.getmaxyx()
        top, left, span = max(0, (height - 14) // 2), max(0, (width - 52) // 2), min(52, width - 2)
        def line(row, text, offset=0, active=False, accent=False):
            y, x = top + row, left + offset
            if 0 <= y < height and 0 <= x < width - 1:
                self.screen.addnstr(y, x, text, width - x - 1,
                    curses.A_REVERSE if active else self.accent if accent else curses.A_NORMAL)
        for row, word in enumerate(WORDMARK):
            line(row, word.center(span), accent=True)
        if status:
            line(5, status.center(span))
        elif width < 54 or height < 18:
            line(4, 'Resize to 54 columns and 18 rows.')
        else:
            line(4, 'Set your password'.center(span))
            for index, label in enumerate(('Password', 'Repeat password')):
                line(7 + index * 2, label)
                mask = ('*' * len(self.values[index]))[-(span - 21):]
                line(7 + index * 2, (' ' + mask).ljust(span - 18), 18, active=self.focus == index)
            line(11, self.error)
            line(13, '[ Start Harness ]', (span - 17) // 2, active=self.focus == 2)
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        self.screen.refresh()
        return width >= 54 and height >= 18

    def password(self):
        while True:
            usable = self.render()
            key = self.screen.get_wch()
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
                        FirstBoot.validate_password(*self.values)
                        password = self.values[0]
                        self.values = ['', '']
                        return password
                    except ValueError as error:
                        self.error = str(error)
            elif self.focus < 2:
                if key in ('\b', '\x7f', curses.KEY_BACKSPACE):
                    self.values[self.focus] = self.values[self.focus][:-1]
                elif key == '\x15':
                    self.values[self.focus] = ''
                elif isinstance(key, str) and key.isprintable() and len(self.values[self.focus]) < 4096:
                    self.values[self.focus] += key
                self.error = ''


def main():
    setup = FirstBoot()
    def page(screen):
        curses.raw()
        view = PasswordPage(screen)
        with setup.locked():
            state = setup.prepare()
            while state['phase'] == 'account':
                password = view.password()
                view.render('Starting Harness…')
                try:
                    setup.provision(state, password)
                except session.SetupError as error:
                    view.error = str(error)
                    view.focus = 0
                finally:
                    password = None
            view.render('Starting Harness…')
            setup.finish(state)
    curses.set_escdelay(25)
    curses.wrapper(page)


if __name__ == '__main__':
    main()
