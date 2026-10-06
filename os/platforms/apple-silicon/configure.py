#!/usr/bin/python3
"""KIWI chroot hook; never run on a user's installed system."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess


INPUT = Path('/var/tmp/harness-image-input')


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    if (os.environ.get('HARNESS_ASAHI_IMAGE_BUILD') != '1' or os.geteuid() != 0 or
            platform.machine() != 'aarch64' or not Path('/.kconfig').is_file() or
            platform.freedesktop_os_release().get('ID') != 'fedora'):
        raise RuntimeError('Run only in the native Fedora KIWI image-build chroot.')
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
    # No known-password fixture users, autologin or broad privilege grants.
    # Fedora's stock initial-setup remains until Harness first boot is integrated.
    accounts = [row.split(':') for row in Path('/etc/passwd').read_text().splitlines()]
    if any(1000 <= int(row[2]) < 65534 for row in accounts):
        raise RuntimeError('An image must not contain a pre-provisioned login account.')
    root = next(row.split(':') for row in Path('/etc/shadow').read_text().splitlines() if row.startswith('root:'))
    if not root[1].startswith(('!', '*')):
        raise RuntimeError('An image must not contain an unlocked root account.')
    shutil.rmtree(INPUT)


if __name__ == '__main__':
    main()
