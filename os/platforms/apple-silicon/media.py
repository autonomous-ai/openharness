#!/usr/bin/python3
"""Launch the offline installer from its private, immutable live-media payload."""
from contextlib import contextmanager
import curses
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess

HERE = Path(__file__).resolve().parent
DATA = Path('/usr/share/harness-installer')
spec = importlib.util.spec_from_file_location('asahi_install', HERE / 'install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def identity(folder=DATA, owner_uid=0):
    manifest = folder / 'media.json'
    payload = folder / 'payload.raw'
    for path in (manifest, payload):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022:
            raise ValueError('The installation files have changed. Recreate the installer USB.')
    value = json.loads(manifest.read_text())
    image = value.get('payload', {})
    if (value.get('schema') != 1 or value.get('kind') != 'harness-asahi-installer-media' or
            value.get('published') is not False or value.get('release_ready') is not False or
            not re.fullmatch('[a-f0-9]{40}', str(value.get('source_commit'))) or
            not re.fullmatch('[a-f0-9]{40}', str(image.get('source_commit'))) or
            not re.fullmatch('[a-f0-9]{64}', str(image.get('sha256'))) or
            type(image.get('bytes')) is not int or image['bytes'] != payload.stat().st_size):
        raise ValueError('The installation manifest is incomplete. Recreate the installer USB.')
    return value


@contextmanager
def payload_device(folder=DATA):
    info = identity(folder)['payload']
    # The raw image stays compressed inside SquashFS and is never expanded into
    # RAM. The existing installer verifies every byte before any target writes.
    run = installer.storage.run
    loop = run('losetup', '--find', '--show', '--read-only', '--partscan',
               '--sector-size', '4096', folder / 'payload.raw').strip()
    if not re.fullmatch('/dev/loop[0-9]+', loop):
        raise ValueError('Could not open the installation files.')
    try:
        run('udevadm', 'settle', '--timeout=15')
        yield installer.storage.Payload(loop, info['sha256'], info['source_commit'])
    finally:
        run('losetup', '--detach', loop)


def stopped(screen, message):
    view = installer.Page(screen)
    try:
        while True:
            view.render(status=message)
            view.button(11, 'Shut down', 2, compact=True)
            screen.refresh()
            if view.key() in ('\n', '\r', curses.KEY_ENTER):
                installer.storage.run('systemctl', 'poweroff')
                return
    finally:
        view.close()


def main():
    if platform.system() != 'Linux' or os.geteuid() != 0:
        raise SystemExit('Start from the private Harness installer media.')
    # The service owns this namespace. The install command also defends its own
    # namespace so it remains usable independently in maintenance environments.
    if os.readlink('/proc/self/ns/mnt') == os.readlink('/proc/1/ns/mnt'):
        os.execv('/usr/bin/unshare', ['unshare', '--mount', '--propagation', 'private',
                                   '/usr/bin/python3', str(HERE / 'media.py')])
    curses.set_escdelay(25)
    lock = os.open('/run/harness-asahi-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    installer.target.private_file(lock)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        with payload_device() as payload:
            installer.target.platform_esp()
            curses.wrapper(lambda screen: installer.application(screen, payload))
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        installer.diagnostic(error)
        curses.wrapper(lambda screen: stopped(screen,
            'Installation could not start. Prepare this Mac with the Asahi UEFI installer. '
            'Details: /var/log/harness-asahi-install.log'))
    finally:
        os.close(lock)


if __name__ == '__main__':
    main()
