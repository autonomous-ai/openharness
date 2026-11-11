#!/usr/bin/env python3
"""The newest Arch OpenCode, for one ISO build: its version, and its package verified for the image.

The image's Arch snapshot is fixed (lock.json `arch_snapshot`), and its OpenCode was too: 2.0.21 from
2026/10/01 while Arch had 2.2.5. An image takes the newest OpenCode Arch has when it is built instead
(owner, 2026-11-03), through the build's own repository, which pacman reads before the snapshot's
(build.sh). Only an image: an OS update never changes OpenCode (installer.py `IgnorePkg`), so a
computer keeps the one its image brought until it is installed again.

The package is Arch's own, signed by its packager, and checked against the build's keyring.
"""
import argparse
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.request import Request, urlopen

LATEST = 'https://archlinux.org/packages/extra/x86_64/opencode/json/'
# Every version Arch ever had, under the name pacman gives it.
ARCHIVE = 'https://archive.archlinux.org/packages/o/opencode/'
VERSION = re.compile(r'\d+(?:\.\d+)*-\d+')
AGENT = {'User-Agent': 'Harness-OS-Build/1'}


def latest_version():
    """Arch's current OpenCode, as `2.2.5-1`."""
    with urlopen(Request(LATEST, headers=AGENT), timeout=30) as response:
        info = json.load(response)
    version = f"{info['pkgver']}-{info['pkgrel']}"
    if info.get('epoch') not in (None, 0, '0') or not VERSION.fullmatch(version):
        raise ValueError('Unexpected OpenCode version: ' + version)
    return version


def package_name(version):
    return f'opencode-{version}-x86_64.pkg.tar.zst'


def fetch(version, output):
    """[version]'s package and its signature in [output], the signature verified."""
    if not VERSION.fullmatch(version):
        raise ValueError('Use a full package version, such as 2.2.5-1.')
    output.mkdir(parents=True, exist_ok=True)
    package = output / package_name(version)
    for path in (package, package.with_name(package.name + '.sig')):
        with urlopen(Request(ARCHIVE + path.name, headers=AGENT), timeout=300) as response, path.open('wb') as handle:
            shutil.copyfileobj(response, handle)
    # Its words on stderr: stdout is the package path alone, for build.sh to read.
    subprocess.run(['pacman-key', '--verify', str(package) + '.sig', str(package)], check=True, stdout=sys.stderr)
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--output', type=Path, required=True, help='the build repository to put it in')
    parser.add_argument('--version', help="a version to take instead of Arch's newest")
    args = parser.parse_args()
    print(fetch(args.version or latest_version(), args.output))


if __name__ == '__main__':
    main()
