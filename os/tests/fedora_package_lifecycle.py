#!/usr/bin/env python3
"""Exercise the session RPM only inside a disposable native Fedora container.

This verifies packaging and existing-user preservation, not an installed ARM OS,
graphical session, Apple hardware, system updates or boot recovery.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import time


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def identity(folder, source, producer):
    manifest = json.loads((folder / 'package-manifest.json').read_text())
    assert (manifest['schema'], manifest['kind'], manifest['architecture'], manifest['published']) == (
        1, 'harness-os-fedora-session', 'aarch64', False)
    assert manifest['package_source_commit'] == source
    assert manifest['runtime_source_commit'] == producer
    name = manifest['package']['name']
    assert re.fullmatch(r'harness-os-session-[0-9A-Za-z.~+_-]+\.aarch64\.rpm', name), 'Unsafe package filename'
    package = folder / name
    assert package.is_file() and not package.is_symlink()
    assert package.stat().st_size == manifest['package']['bytes']
    assert digest(package) == manifest['package']['sha256']
    assert manifest['runtime']['system_profile'] == 'fedora'
    for relative in [*manifest['files'], *manifest['symlinks']]:
        path = Path(relative)
        assert not path.is_absolute() and '..' not in path.parts and path.parts[0] == 'usr'
    return package, manifest


def fingerprint(path):
    if path.is_symlink():
        return {'symlink': os.readlink(path)}
    if path.is_file():
        return {'sha256': digest(path), 'mode': path.stat().st_mode & 0o7777}
    if path.is_dir():
        return {str(child.relative_to(path)): fingerprint(child) for child in sorted(path.iterdir())}
    assert not path.exists(), 'Unexpected filesystem object: ' + str(path)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--first', type=Path, required=True)
    parser.add_argument('--repeat', type=Path, required=True)
    parser.add_argument('--upgrade', type=Path, required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--runtime-source', required=True)
    parser.add_argument('--root-image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if (not Path('/.dockerenv').is_file() or platform.system() != 'Linux' or
            platform.machine() != 'aarch64' or os.geteuid() != 0):
        parser.error('Use a disposable native aarch64 Fedora Docker container, never the host.')
    for value in (args.source, args.runtime_source):
        assert re.fullmatch(r'[a-f0-9]{40}', value), 'Use exact source identities'
    locked_image = json.loads(Path(__file__).with_name('arm-session.lock.json').read_text())['root_image']
    assert args.root_image == locked_image, 'Use the locked Fedora root image'
    assert re.search(r'^ID=fedora$', Path('/etc/os-release').read_text(), re.M)
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'status': 'running', 'started_at': time.time(), 'test_source_commit': args.source,
               'runtime_source_commit': args.runtime_source, 'root_image': args.root_image,
               'scope': 'Native RPM reproducibility, dependency installation, upgrade and removal',
               'checks': [], 'limitations': ['Container; no graphical, kernel, hardware, boot or system recovery proof']}
    log = (output / 'commands.log').open('w')

    def run(*command, timeout=120, check=True):
        log.write(json.dumps(list(map(str, command))) + '\n')
        log.flush()
        completed = subprocess.run(list(map(str, command)), text=True, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, timeout=timeout)
        log.write(completed.stdout)
        log.flush()
        if check and completed.returncode:
            raise RuntimeError(f'{command[0]} exited {completed.returncode}; see commands.log')
        return completed

    try:
        first, old = identity(args.first, args.source, args.runtime_source)
        repeat, repeated = identity(args.repeat, args.source, args.runtime_source)
        upgrade, new = identity(args.upgrade, args.source, args.runtime_source)
        assert first.read_bytes() == repeat.read_bytes(), 'Same inputs produced different RPM bytes'
        assert old['files'] == repeated['files'] == new['files']
        assert old['symlinks'] == repeated['symlinks'] == new['symlinks']
        assert old['package']['version'] == new['package']['version']
        assert str(old['package']['release']) == '1' and str(new['package']['release']) == '2'
        for rpm in (first, upgrade):
            assert not run('rpm', '-qp', '--scripts', rpm).stdout.strip(), 'Package contains service/account scriptlets'
            assert not run('rpm', '-qp', '--triggers', rpm).stdout.strip(), 'Package contains transaction triggers'
        receipt['packages'] = {'first': old, 'upgrade': new}
        receipt['checks'].append('Independent same-input builds produce identical RPM bytes; upgrade changes only RPM release')

        # This existing user's data must survive every package operation. The
        # package must not create the OS image's default account or login policy.
        assert run('getent', 'passwd', 'me', check=False).returncode != 0
        run('useradd', '--create-home', '--shell', '/bin/bash', 'harness-rpm-probe')
        home = Path('/home/harness-rpm-probe')
        for relative, text in [('projects/proof/main.py', 'print("my existing project")\n'),
                               ('.config/opencode/AGENTS.md', 'Keep these personal instructions.\n'),
                               ('.bash_profile', '# Existing login configuration\n')]:
            target = home / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        run('chown', '-R', 'harness-rpm-probe:harness-rpm-probe', home)
        preserved = [home, Path('/etc/profile.d/harness-os.sh'), Path('/etc/NetworkManager/conf.d/10-dns.conf'),
                     Path('/etc/systemd/system/getty@tty1.service.d'), Path('/etc/systemd/system/default.target'),
                     Path('/etc/systemd/user/default.target.wants'), Path('/etc/hostname'), Path('/etc/hosts'),
                     Path('/etc/sudoers.d/99-harness-update-test')]
        before = {str(path): fingerprint(path) for path in preserved}
        account = run('getent', 'passwd', 'harness-rpm-probe').stdout
        manager = shutil.which('dnf5') or shutil.which('microdnf')
        assert manager, 'The locked Fedora image must provide a package manager'
        transaction = [manager, '-y', '--setopt=install_weak_deps=False', '--setopt=gpgcheck=True',
                       '--setopt=localpkg_gpgcheck=False', '--nodocs', 'install']
        for label, rpm, metadata in [('install', first, old), ('upgrade', upgrade, new)]:
            run(*transaction, rpm, timeout=600)
            assert run('rpm', '-q', '--qf', '%{NAME}\t%{VERSION}\t%{RELEASE}\t%{ARCH}',
                       'harness-os-session').stdout == '\t'.join([
                           'harness-os-session', metadata['package']['version'],
                           str(metadata['package']['release']), 'aarch64'])
            assert not run('rpm', '-V', 'harness-os-session').stdout.strip()
            installed = set(run('rpm', '-ql', 'harness-os-session').stdout.splitlines())
            expected = {'/' + path for path in [*metadata['files'], *metadata['symlinks']]}
            assert expected <= installed, 'RPM does not own every declared payload file'
            for path in installed:
                assert path.startswith('/usr/'), 'Package owns host configuration or boot data: ' + path
                if not Path(path).is_dir():
                    assert path in expected, 'Undeclared file in package: ' + path
            for relative, sha256 in metadata['files'].items():
                assert digest(Path('/') / relative) == sha256, 'Installed bytes differ: ' + relative
            for relative, target in metadata['symlinks'].items():
                assert os.readlink(Path('/') / relative) == target
            owners = run('rpm', '-q', '--qf', '[%{FILEUSERNAME}\t%{FILEGROUPNAME}\n]', 'harness-os-session').stdout
            assert all(line == 'root\troot' for line in owners.splitlines())
            assert {str(path): fingerprint(path) for path in preserved} == before, 'Existing user/login/network policy changed'
            assert run('getent', 'passwd', 'harness-rpm-probe').stdout == account
            assert run('getent', 'passwd', 'me', check=False).returncode != 0, 'Package created a default OS account'
            receipt['checks'].append(f'Native {label}: declared payload owned/verified, existing user and host configuration unchanged')
        # A plain RPM erase is intentional: dependency autoremoval is a separate
        # DNF policy and must not disguise removal of this package's own files.
        run('rpm', '-e', 'harness-os-session')
        assert run('rpm', '-q', 'harness-os-session', check=False).returncode != 0
        for relative in [*new['files'], *new['symlinks']]:
            path = Path('/') / relative
            assert not path.exists() and not path.is_symlink(), 'RPM left an owned file: ' + relative
        assert {str(path): fingerprint(path) for path in preserved} == before
        assert run('getent', 'passwd', 'harness-rpm-probe').stdout == account
        receipt['checks'].append('Removal cleans all package-owned files and preserves the existing account, project and configuration')
        receipt['status'] = 'passed'
    except BaseException as error:
        receipt.update(status='failed', error=str(error))
        raise
    finally:
        receipt['finished_at'] = time.time()
        log.close()
        (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')


if __name__ == '__main__':
    main()
