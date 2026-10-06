#!/usr/bin/python3
"""Explicit, reversible console login setup for the private Fedora session RPM."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import tempfile


STATE = 'var/lib/harness-os/session-setup.json'
CONFIG = 'etc/greetd/harness.toml'
DROPIN = 'etc/systemd/system/greetd.service.d/90-harness.conf'
SUDOERS = 'etc/sudoers.d/harness-session-network'
ALIAS = 'etc/systemd/system/display-manager.service'
TARGET = 'etc/systemd/system/default.target'
PATHS = (CONFIG, DROPIN, SUDOERS, ALIAS, TARGET)
USERNAME = re.compile(r'[A-Za-z_][A-Za-z0-9_.-]{0,31}')


class SetupError(RuntimeError):
    pass


def regular(text, mode=0o644):
    return {'kind': 'file', 'text': text, 'mode': mode}


def link(target):
    return {'kind': 'link', 'target': target}


class Setup:
    def __init__(self, root=Path('/')):
        self.root = root

    def path(self, name):
        path = self.root / name
        # Never follow an administrator's redirected configuration directory.
        for parent in path.parents:
            if parent == self.root:
                break
            if parent.is_symlink():
                raise SetupError('Refusing a symlink configuration directory: ' + str(parent))
            if parent.exists():
                info = parent.stat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                    raise SetupError('Configuration directory is not securely owned: ' + str(parent))
        return path

    def snapshot(self, name):
        path = self.path(name)
        try:
            info = path.lstat()
        except FileNotFoundError:
            return None
        if info.st_uid != os.geteuid():
            raise SetupError('Configuration has a different owner: ' + str(path))
        if stat.S_ISLNK(info.st_mode):
            return link(os.readlink(path))
        if stat.S_ISREG(info.st_mode):
            return regular(path.read_text(), stat.S_IMODE(info.st_mode))
        raise SetupError('Refusing a special configuration file: ' + str(path))

    def run(self, *command, check=True):
        result = subprocess.run(command, stdin=subprocess.DEVNULL, text=True,
                                capture_output=True, timeout=20)
        if check and result.returncode:
            raise SetupError(command[0] + ' failed: ' + (result.stderr or result.stdout).strip()[-500:])
        return result.stdout.strip()

    def sync_directory(self, path):
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def write(self, name, entry, replace=False):
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix='.harness-setup-', dir=path.parent)
        try:
            if entry['kind'] == 'link':
                os.close(descriptor)
                os.unlink(temporary)
                os.symlink(entry['target'], temporary)
            else:
                with os.fdopen(descriptor, 'w') as stream:
                    os.fchmod(stream.fileno(), entry['mode'])
                    stream.write(entry['text'])
                    stream.flush()
                    os.fsync(stream.fileno())
                if name == SUDOERS:
                    self.run('/usr/sbin/visudo', '-c', '-f', temporary)
            if replace:
                os.replace(temporary, path)
            else:
                os.link(temporary, path, follow_symlinks=False)
            self.sync_directory(path.parent)
        finally:
            if os.path.lexists(temporary):
                os.unlink(temporary)

    def save(self, state):
        previous = self.snapshot(STATE)
        if previous is not None and (previous['kind'] != 'file' or previous['mode'] != 0o600):
            raise SetupError('The setup receipt must be a private regular file.')
        self.write(STATE, regular(json.dumps(state, indent=2) + '\n', 0o600), replace=True)

    def load(self):
        entry = self.snapshot(STATE)
        if entry is None:
            return None
        if entry['kind'] != 'file' or entry['mode'] != 0o600:
            raise SetupError('The setup receipt must be a private regular file.')
        state = json.loads(entry['text'])
        if (state.get('schema') != 1 or state.get('phase') not in {'enabling', 'enabled', 'disabling'} or
                not USERNAME.fullmatch(str(state.get('user', ''))) or
                set(state.get('files', {})) != set(PATHS)):
            raise SetupError('Unrecognized setup receipt; preserve it for recovery.')
        expected = self.plan(state['user'], state['files'][TARGET]['before'], state['previous_target'],
                             state['files'][ALIAS]['before'])
        if state['files'] != expected or state.get('created_dirs') != [
                name for name in state.get('created_dirs', []) if name in {
                    'etc/systemd/system/greetd.service.d', 'var/lib/harness-os'}]:
            raise SetupError('Setup receipt has unexpected file changes; preserve it for recovery.')
        return state

    @contextlib.contextmanager
    def locked(self):
        path = self.path('run/harness-session-setup.lock')
        descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise SetupError('The setup lock is not securely owned.')
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise SetupError('Another session setup is running.') from error
            yield
        finally:
            os.close(descriptor)

    def account(self, user):
        if not USERNAME.fullmatch(user):
            raise SetupError('Choose an existing local account with a conventional login name.')
        accounts = [line.split(':') for line in self.path('etc/passwd').read_text().splitlines()]
        account = next((row for row in accounts if len(row) == 7 and row[0] == user), None)
        limits = self.path('etc/login.defs').read_text()
        minimum = re.search(r'^\s*UID_MIN\s+(\d+)', limits, re.MULTILINE)
        if not account or int(account[2]) < max(1, int(minimum[1]) if minimum else 1000):
            raise SetupError('Choose an existing, non-root local user account.')
        shells = self.path('etc/shells').read_text().splitlines()
        home = self.root / account[5].lstrip('/')
        shell = self.root / account[6].lstrip('/')
        if (not account[5].startswith('/') or not home.is_dir() or home.stat().st_uid != int(account[2]) or
                account[6] not in shells or Path(account[6]).name in {'false', 'nologin'} or
                not os.access(shell, os.X_OK)):
            raise SetupError('The selected account needs its existing home and an enabled login shell.')
        shadows = [line.split(':') for line in self.path('etc/shadow').read_text().splitlines()]
        shadow = next((row for row in shadows if len(row) == 9 and row[0] == user), None)
        today = (datetime.date.today() - datetime.date(1970, 1, 1)).days
        # shadow(5): an empty last-change field disables password aging. Asahi's
        # initial-setup creates these valid accounts; only zero forces a change.
        if (not shadow or not shadow[1] or shadow[1][0] in '!*' or
                (shadow[2] and int(shadow[2]) == 0) or
                not re.fullmatch(r'\$[^$\s:]+\$[^:\s]{10,}|[./0-9A-Za-z]{13}', shadow[1]) or
                (shadow[7] and int(shadow[7]) >= 0 and int(shadow[7]) <= today) or
                (shadow[2] and int(shadow[2]) > 0 and shadow[4] and int(shadow[4]) >= 0 and
                 int(shadow[2]) + int(shadow[4]) <= today)):
            raise SetupError('The selected account needs a usable, unexpired password for recovery login.')
        # Query existing policy as root; do not authenticate or grant administrative access.
        self.run('/usr/bin/sudo', '-n', '-l', '-U', user, '--', '/usr/bin/harness-session-setup', 'disable')
        return int(account[2])

    def preflight(self, user):
        release = self.path('etc/os-release').read_text()
        # The maintained Asahi image identifies itself as fedora-asahi-remix.
        # Accept these two explicit identities, not every ID_LIKE=fedora system.
        fedora = re.search(r'''^ID=(["']?)(fedora|fedora-asahi-remix)\1$''', release, re.MULTILINE)
        if (platform.machine() != 'aarch64' or not fedora or
                json.loads(self.path('usr/share/harness-os/runtime.json').read_text()).get('system_profile') != 'fedora'):
            raise SetupError('This setup is only for the native Fedora ARM session package.')
        for binary in ('usr/bin/greetd', 'usr/bin/agreety', 'usr/bin/harness-session', 'usr/sbin/visudo'):
            if not os.access(self.root / binary, os.X_OK):
                raise SetupError('Install Fedora\'s greetd and sudo packages before enabling the session.')
        self.run('/usr/bin/rpm', '-V', 'greetd')
        # Bound the files systemctl enable may create to the vendor alias we record.
        unit = self.path('usr/lib/systemd/system/greetd.service').read_text()
        install = re.search(r'^\[Install\]\s*\n(.*?)(?=^\[|\Z)', unit, re.MULTILINE | re.DOTALL)
        settings = [line.strip() for line in install[1].splitlines()
                    if line.strip() and not line.lstrip().startswith(('#', ';'))] if install else []
        if settings != ['Alias=display-manager.service']:
            raise SetupError('The installed greetd enablement policy differs; review it before setup.')
        if self.path('sys/fs/selinux/enforce').exists():
            self.run('/usr/bin/rpm', '-q', 'greetd-selinux')
        self.run('/usr/sbin/visudo', '-c')
        for service in ('greetd.service', 'display-manager.service'):
            if self.run('/usr/bin/systemctl', 'is-active', service, check=False) not in {'inactive', 'failed'}:
                raise SetupError('An existing login manager is active; keep its configuration.')
        alias_before = self.snapshot(ALIAS)
        enabled = self.run('/usr/bin/systemctl', 'is-enabled', 'greetd.service', check=False)
        if not ((enabled == 'disabled' and alias_before is None) or
                (enabled == 'enabled' and alias_before == link('/usr/lib/systemd/system/greetd.service'))):
            raise SetupError('greetd has a different enablement or mask; keep its configuration.')
        for prefix in ('etc', 'run', 'usr/lib'):
            for name in ('greetd.service', 'display-manager.service'):
                if prefix == 'etc' and name == 'display-manager.service' and alias_before is not None:
                    continue  # Fedora's pristine package preset is retained on disable.
                if ((prefix != 'usr/lib' or name == 'display-manager.service') and
                        self.snapshot(prefix + '/systemd/system/' + name) is not None):
                    raise SetupError('An existing login-manager override or alias is present.')
            overrides = self.path(prefix + '/systemd/system/greetd.service.d')
            if overrides.exists() and any(overrides.iterdir()):
                raise SetupError('An existing greetd override is present.')
        if self.run('/usr/bin/systemctl', 'is-enabled', 'getty@tty2.service', check=False).startswith('masked'):
            raise SetupError('The recovery console on tty2 is masked.')
        previous_target = self.run('/usr/bin/systemctl', 'get-default')
        if previous_target not in {'multi-user.target', 'graphical.target'}:
            raise SetupError('Keep the existing custom boot target.')
        before = self.snapshot(TARGET)
        if before is not None and before not in [link('/' + directory + '/' + previous_target)
                                                for directory in ('usr/lib/systemd/system', 'lib/systemd/system')]:
            raise SetupError('Keep the existing custom default-target configuration.')
        files = self.plan(user, before, previous_target, alias_before)
        for name, change in files.items():
            if self.snapshot(name) != change['before']:
                raise SetupError('Configuration already exists: /' + name)
        return self.account(user), previous_target, files

    def plan(self, user, target_before, previous_target, alias_before=None):
        if previous_target not in {'multi-user.target', 'graphical.target'}:
            raise SetupError('Unrecognized original target in setup receipt.')
        if target_before is not None and target_before not in [
                link('/' + directory + '/' + previous_target)
                for directory in ('usr/lib/systemd/system', 'lib/systemd/system')]:
            raise SetupError('Unrecognized original target link in setup receipt.')
        if alias_before not in (None, link('/usr/lib/systemd/system/greetd.service')):
            raise SetupError('Unrecognized original login-manager alias in setup receipt.')
        config = ('[terminal]\nvt = 1\n\n[general]\nsource_profile = false\n\n'
                  '[default_session]\ncommand = "/usr/bin/agreety --cmd /usr/bin/harness-session"\n'
                  'user = "greetd"\n\n[initial_session]\ncommand = "/usr/bin/harness-session"\n'
                  'user = ' + json.dumps(user) + '\n')
        sudoers = ('# Managed by harness-session-setup; only the existing network form.\n' + user +
                   ' ALL=(root) NOPASSWD: /usr/bin/python3 /usr/lib/harness-os/network.py, '
                   '/usr/bin/python3 /usr/lib/harness-os/network.py --first-use\n')
        files = {name: {'before': None, 'after': entry} for name, entry in [
            (CONFIG, regular(config)),
            (DROPIN, regular('[Service]\nExecStart=\nExecStart=/usr/bin/greetd --config /etc/greetd/harness.toml\n')),
            (SUDOERS, regular(sudoers, 0o440)),
            (ALIAS, link('/usr/lib/systemd/system/greetd.service')),
        ]}
        files[TARGET] = {'before': target_before, 'after': target_before if previous_target == 'graphical.target'
                         else link('/usr/lib/systemd/system/graphical.target')}
        files[ALIAS]['before'] = alias_before
        return files

    def verify(self, state, partial=False):
        for name, change in state['files'].items():
            current = self.snapshot(name)
            permitted = [change['after']]
            if partial:
                permitted.append(change['before'])
                if name == TARGET:
                    # Recover an interrupted systemctl replacement of the old link.
                    permitted.append(None)
            if current not in permitted:
                raise SetupError('Managed configuration changed; preserve it and the receipt: /' + name)

    def rollback(self, state):
        self.verify(state, partial=True)
        for name in reversed(PATHS):
            change = state['files'][name]
            if self.snapshot(name) == change['before']:
                continue
            if change['before'] is None:
                self.path(name).unlink()
                self.sync_directory(self.path(name).parent)
            else:
                self.write(name, change['before'], replace=True)
        self.path(STATE).unlink()
        self.sync_directory(self.path(STATE).parent)
        for name in reversed(state['created_dirs']):
            try:
                self.path(name).rmdir()
            except OSError:
                pass  # Never remove another component's files.

    def enable(self, user):
        existing = self.load()
        if existing:
            if existing['phase'] != 'enabled':
                raise SetupError('A previous setup was interrupted. Run harness-session-setup disable to restore it.')
            if existing['user'] != user:
                raise SetupError('Disable the existing setup before selecting a different account.')
            self.verify(existing)
            if self.account(user) != existing['uid']:
                raise SetupError('The selected account identity has changed; disable the existing setup.')
            return 'Harness login is already enabled for ' + user + '.'
        uid, target, files = self.preflight(user)
        state = {'schema': 1, 'phase': 'enabling', 'user': user, 'uid': uid,
                 'previous_target': target, 'files': files,
                 'created_dirs': [name for name in ('var/lib/harness-os', 'etc/systemd/system/greetd.service.d')
                                  if not self.path(name).exists()]}
        self.save(state)  # Durable before any login policy changes.
        try:
            for name in (CONFIG, DROPIN, SUDOERS):
                self.write(name, files[name]['after'])
                if self.path('sys/fs/selinux/enforce').exists():
                    self.run('/usr/sbin/restorecon', str(self.path(name)))
            # Use Fedora's unit Install policy. Neither command starts/stops a service.
            self.run('/usr/bin/systemctl', '--no-reload', 'enable', 'greetd.service')
            if target != 'graphical.target':
                self.run('/usr/bin/systemctl', '--no-reload', 'set-default', 'graphical.target')
            self.verify(state)
            state['phase'] = 'enabled'
            self.save(state)
        except BaseException:
            self.rollback(state)
            raise
        return 'Harness login is enabled for ' + user + ' on the next boot. The running session is unchanged.'

    def disable(self):
        state = self.load()
        if not state:
            return 'Harness login is not enabled by this setup.'
        self.verify(state, partial=state['phase'] != 'enabled')
        state['phase'] = 'disabling'
        self.save(state)
        self.rollback(state)
        return 'The previous login setup is restored for the next boot. The running session is unchanged.'

    def status(self):
        state = self.load()
        if not state:
            return 'Harness login is not enabled by this setup.'
        self.verify(state, partial=state['phase'] != 'enabled')
        return json.dumps({key: state[key] for key in ('phase', 'user', 'uid', 'previous_target')}, indent=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    enable = commands.add_parser('enable', help='Enable next-boot login for an existing local account.')
    enable.add_argument('--user', required=True)
    enable.add_argument('--autologin', action='store_true', required=True,
                        help='Deliberately allow this account to log in without a password at boot.')
    commands.add_parser('disable', help='Restore the previous login setup on the next boot.')
    commands.add_parser('status')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run this setup through sudo.')
    setup = Setup()
    try:
        with setup.locked():
            print(setup.enable(args.user) if args.command == 'enable' else getattr(setup, args.command)())
    except (SetupError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
