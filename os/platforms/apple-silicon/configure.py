#!/usr/bin/python3
"""KIWI chroot hook; never run on a user's installed system."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess


INPUT = Path('/var/tmp/harness-image-input')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def require_build_environment():
    release = platform.freedesktop_os_release()
    context = {'enabled': os.environ.get('HARNESS_ASAHI_IMAGE_BUILD') == '1',
               'uid': os.geteuid(), 'architecture': platform.machine(),
               'kiwi': Path('/.kconfig').is_file(), 'id': release.get('ID'),
               'release': release.get('VERSION_ID')}
    if context != {'enabled': True, 'uid': 0, 'architecture': 'aarch64', 'kiwi': True,
                   'id': 'fedora-asahi-remix', 'release': '44'}:
        raise RuntimeError('Run only in the native Fedora Asahi KIWI chroot: ' + json.dumps(context))


def main():
    require_build_environment()
    identity = json.loads((INPUT / 'image.json').read_text())
    if identity.get('kind') != 'harness-asahi-image-construction' or identity.get('release_ready') is not False:
        raise ValueError('Missing private image construction identity.')
    manifest = identity['session_package']
    item = manifest['package']
    if not re.fullmatch(r'harness-os-session-[A-Za-z0-9.~+-]+\.aarch64\.rpm', item['name']):
        raise ValueError('Invalid session RPM name.')
    package = INPUT / item['name']
    if package.is_symlink() or package.stat().st_size != item['bytes'] or digest(package) != item['sha256']:
        raise ValueError('The declared session RPM has changed.')
    # The upstream recipe checks signatures for every Fedora/Asahi dependency.
    # Only this exact SHA-256-verified private RPM is unsigned. With all repos
    # disabled this transaction cannot resolve/download a different package.
    subprocess.run(['dnf5', '-y', '--disable-repo=*', '--setopt=localpkg_gpgcheck=False',
                    'install', str(package)], check=True)
    subprocess.run(['rpm', '-V', 'harness-os-session'], check=True)
    for name, expected in manifest['files'].items():
        path = Path('/') / name
        if path.is_symlink() or digest(path) != expected:
            raise ValueError('Installed session payload differs: ' + name)
    for name, expected in manifest['symlinks'].items():
        if os.readlink(Path('/') / name) != expected:
            raise ValueError('Installed session link differs: ' + name)
    Path('/etc/hostname').write_text('harness\n')
    Path('/usr/share/harness-os/image.json').write_text(json.dumps(identity, indent=2) + '\n')
    # Only the dedicated image configures first boot; the general session RPM
    # still has no account-creation or automatic login side effects.
    first_boot = identity['first_boot']['files']
    if set(first_boot) != {'usr/lib/harness-os/firstboot.py',
                          'usr/lib/systemd/system/harness-firstboot.service',
                          'usr/lib/systemd/system-preset/01-harness-firstboot.preset'}:
        raise ValueError('Incomplete first-boot payload declaration.')
    for name, expected in first_boot.items():
        path = Path('/') / name
        if (path.is_symlink() or digest(path) != expected['sha256'] or
                stat.S_IMODE(path.stat().st_mode) != expected['mode']):
            raise ValueError('First-boot payload differs: ' + name)
    subprocess.run(['systemctl', 'disable', 'initial-setup.service',
                    'initial-setup-reconfiguration.service'], check=True)
    Path('/etc/reconfigSys').unlink(missing_ok=True)
    subprocess.run(['systemctl', 'enable', 'harness-firstboot.service'], check=True)
    # No account, known password, or enabled Harness autologin is baked in.
    accounts = [row.split(':') for row in Path('/etc/passwd').read_text().splitlines()]
    if any(1000 <= int(row[2]) < 65534 for row in accounts):
        raise RuntimeError('An image must not contain a pre-provisioned login account.')
    root = next(row.split(':') for row in Path('/etc/shadow').read_text().splitlines() if row.startswith('root:'))
    if not root[1].startswith(('!', '*')):
        raise RuntimeError('An image must not contain an unlocked root account.')
    shutil.rmtree(INPUT)


if __name__ == '__main__':
    main()
