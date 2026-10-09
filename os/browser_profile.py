#!/usr/bin/python3
"""Offer the OS start page without replacing an existing New Tab customization.

Only our supported external-extension descriptor is written. Browser preferences,
bookmarks, acknowledgement/disable records and other extensions are read-only.
"""
import json
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time

PACKAGE = Path('/usr/share/harness-os/browser-home/extension.json')


def startup_socket():
    return Path('/run/user') / str(os.getuid()) / 'harness-browser-start' / 'ready'


def installed():
    """One install-only acknowledgment; no persistent helper or browser access."""
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as connection:
        connection.sendto(b'ready', str(startup_socket()))


def pristine(root):
    return (not (root / 'Local State').exists() and
            not (root / 'SingletonLock').is_symlink() and
            not any(root.glob('*/Preferences')) and
            not any(root.glob('*/Secure Preferences')))


@contextmanager
def startup_guard(timeout=20):
    """All launcher requests wait until an owned primer has fully closed."""
    directory = startup_socket().parent
    directory.mkdir(mode=0o700, parents=False, exist_ok=True)
    with (directory / 'lock').open('a') as lock:
        limit = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= limit:
                    raise TimeoutError('Browser is still starting. Try again.')
                time.sleep(.02)
        yield directory


def prime(root, *, deadline_seconds=8):
    """Let a new profile finish installing its page before opening a window.

    Only a browser we start in an unused profile is controlled here. CDP stays
    on private child pipes, never a listening port. Ordinary launches and every
    existing profile skip this one-time step entirely. Caller holds startup_guard
    until this child is closed and the normal launch has been handed off.
    """
    endpoint = startup_socket()
    browser = None
    bound = False
    try:
        endpoint.parent.mkdir(mode=0o700, parents=False, exist_ok=True)
        if not pristine(root):
            return False
        endpoint.unlink(missing_ok=True)
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as ready:
            ready.bind(str(endpoint))
            bound = True
            endpoint.chmod(0o600)
            # The shell only maps Chromium's documented pipe descriptors.
            # All command text is constant; no URL/user input is interpolated.
            browser = subprocess.Popen([
                '/bin/sh', '-c',
                'exec /usr/bin/chromium --headless --no-first-run '
                '--no-default-browser-check --remote-debugging-pipe '
                '--user-data-dir="$1" about:blank 3<&0 4>&1',
                'harness-browser-start', str(root),
            ], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, start_new_session=True)
            ready.settimeout(deadline_seconds)
            return ready.recv(64) == b'ready'
    except (OSError, ValueError, subprocess.SubprocessError):
        return False  # Optional preparation must never prevent normal browsing.
    finally:
        if browser is not None:
            try:
                if browser.poll() is None:
                    browser.stdin.write(b'{"id":1,"method":"Browser.close"}\0')
                    browser.stdin.flush()
                    browser.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                # This group belongs only to the child created above. Never
                # kill Chromium by name or touch an existing browser process.
                try:
                    if browser.poll() is None:
                        os.killpg(browser.pid, signal.SIGTERM)
                        browser.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(browser.pid, signal.SIGKILL)
                        browser.wait(timeout=2)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
                except OSError:
                    pass
            finally:
                for pipe in [browser.stdin, browser.stdout]:
                    try:
                        pipe.close()
                    except OSError:
                        pass
        if bound:
            try:
                endpoint.unlink(missing_ok=True)
            except OSError:
                pass


def read_json(path):
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError('Oversized browser preferences')
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError('Invalid browser preferences')
    return data


def customized(root, extension_id):
    for pattern in ['*/Preferences', '*/Secure Preferences']:
        for path in root.glob(pattern):
            extensions = read_json(path).get('extensions', {})
            for entry in extensions.get('chrome_url_overrides', {}).get('newtab', []):
                url = entry.get('entry', '') if isinstance(entry, dict) else entry
                if not isinstance(url, str) or not url.startswith('chrome-extension://' + extension_id + '/'):
                    return True
            for other_id, entry in extensions.get('settings', {}).items():
                if (other_id != extension_id and
                        'newtab' in entry.get('manifest', {}).get('chrome_url_overrides', {})):
                    return True
    return False


def prepare(root, package=PACKAGE):
    try:
        record = read_json(package)
        extension_id = record['extension_id']
        if not re.fullmatch('[a-p]{32}', extension_id):
            return False
        descriptor = dict(record['descriptor'])
        target = root / 'External Extensions' / (extension_id + '.json')
        if target.is_symlink():
            return False
        previous = None
        if target.exists():
            previous = read_json(target)
            if previous.get('external_crx') != descriptor['external_crx']:
                return False  # This file is no longer ours to update.
        try:
            custom = customized(root, extension_id)
        except (OSError, ValueError, TypeError, AttributeError):
            custom = True  # An unreadable profile is never permission to replace it.
        if custom and previous is None:
            return False
        if custom or (previous and previous.get('keep_if_present')):
            # Descriptors are shared across profiles. An imported profile or a
            # choice made after registration must not acquire a new override.
            # Chromium still updates copies already installed in other profiles.
            descriptor['keep_if_present'] = True
        if previous == descriptor:
            return True
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, mode='w', delete=False) as out:
                temporary = Path(out.name)
                json.dump(descriptor, out)
                out.write('\n')
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return True
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return False  # An optional start page must never prevent browsing.


def launch(args, *, execute=None, lock_timeout=20):
    command = ['systemd-run', '--user', '--quiet', '--collect', '/usr/bin/chromium',
               '--ozone-platform=wayland', '--start-maximized', '--no-first-run',
               '--no-default-browser-check', *args]
    if execute is None:
        execute = lambda command: subprocess.run(command, check=False).returncode
    try:
        with startup_guard(lock_timeout) as directory:
            started = directory / 'launched'
            # Custom profile launches belong to their caller. They still wait
            # behind preparation, including explicit paths to the default profile.
            if not os.environ.get('CHROME_USER_DATA_DIR') and not any(
                    arg == '--user-data-dir' or arg.startswith('--user-data-dir=') for arg in args):
                config = Path(os.environ.get('CHROME_CONFIG_HOME') or os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
                root = config / 'chromium'
                if (prepare(root) and not args and not started.exists() and
                        not (config / 'chromium-flags.conf').exists() and not any(
                            os.environ.get(key) for key in ['CHROME_CONFIG_HOME', 'XDG_CONFIG_HOME'])):
                    prime(root)
            # Prevent another primer while the normal browser is still creating
            # its profile. The marker is private to this user's current login.
            started.touch(mode=0o600, exist_ok=True)
            return execute(command)
    except OSError as error:
        # In particular, never forward a URL into a primer after a lock timeout.
        print(str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(launch(sys.argv[1:]))
