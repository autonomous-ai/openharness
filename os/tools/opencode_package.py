#!/usr/bin/env python3
"""The Arch OpenCode lock.json pins, for one ISO build: its package, verified for the image.

The image's Arch snapshot is fixed (lock.json `arch_snapshot`), and its OpenCode was too: 2.0.21 from
2026/10/01 while Arch had 2.2.5. An image took the newest OpenCode Arch had when it was built
(owner, 2026-11-03), until 0.1.18 took 2.4.1 that way: its answers moved out of its messages and its
pickers were drawn anew, and Chat UI showed no answer and switched no model (MSI, 2026-11-26). The
version is pinned in lock.json `opencode` since, and raised by a change that runs the OS checks with it
(tests/opencode_daemon_guest.mjs drives it as the phone does). It comes through the build's own
repository, which pacman reads before the snapshot's (build.sh). Only an image: an OS update never
changes OpenCode (installer.py `IgnorePkg`), so a computer keeps the one its image brought until it is
installed again.

The package is Arch's own, signed by its packager, and checked against the build's keyring.
"""
import argparse
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.request import Request, urlopen

# Every version Arch ever had, under the name pacman gives it.
ARCHIVE = 'https://archive.archlinux.org/packages/o/opencode/'
VERSION = re.compile(r'\d+(?:\.\d+)*-\d+')
AGENT = {'User-Agent': 'Harness-OS-Build/1'}


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
    parser.add_argument('--version', required=True, help='the version lock.json pins, such as 2.4.1-1')
    args = parser.parse_args()
    print(fetch(args.version, args.output))


if __name__ == '__main__':
    main()
