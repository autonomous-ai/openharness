#!/usr/bin/env python3
"""Exercise the session RPM only inside a disposable native Fedora container.

First provision signed Fedora dependencies with their normal presets, then verify
packaging and existing-user preservation on that base. This does not verify an
installed ARM OS, graphical session, Apple hardware, system updates or boot recovery.
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
import tempfile
import time


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def identity(folder, source, producer, expected_runtime):
    manifest = json.loads((folder / 'package-manifest.json').read_text())
    assert (manifest['schema'], manifest['kind'], manifest['architecture'], manifest['published']) == (
        1, 'harness-os-fedora-session', 'aarch64', False)
    assert manifest['package_source_commit'] == source
    assert manifest['runtime_source_commit'] == producer
    original = manifest['runtime_source_identity']
    assert original == expected_runtime, 'Package runtime differs from the selected producer artifact'
    assert (original['source_commit'], original['dirty'], original['architecture'], original['target']) == (
        producer, False, 'aarch64', 'aarch64-unknown-linux-musl')
    assert set(original['files']) == {'harness-tui', 'cli.js', 'notify.mjs'}
    expected = dict(original, system_profile='fedora', package_source_commit=source,
                    files={('cli.mjs' if name == 'cli.js' else name): entry
                           for name, entry in original['files'].items()})
    assert manifest['runtime'] == expected, 'Installed runtime identity lost its producer provenance'
    for name, entry in expected['files'].items():
        assert manifest['files']['usr/lib/harness/' + name] == entry['sha256']
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


def changed_paths(before, after):
    def flatten(path, value):
        if (value is None or isinstance(value.get('sha256'), str) or
                isinstance(value.get('symlink'), str)):
            return {path: value}
        result = {path: {'directory': True}}
        for name, child in value.items():
            result.update(flatten(str(Path(path) / name), child))
        return result

    old = {name: value for path, state in before.items() for name, value in flatten(path, state).items()}
    new = {name: value for path, state in after.items() for name, value in flatten(path, state).items()}
    return [{'path': path, 'before': old.get(path), 'after': new.get(path)}
            for path in sorted(old.keys() | new.keys()) if old.get(path) != new.get(path)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--first', type=Path, required=True)
    parser.add_argument('--repeat', type=Path, required=True)
    parser.add_argument('--upgrade', type=Path, required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--runtime-source', required=True)
    parser.add_argument('--runtime', type=Path, required=True, help='Original selected producer artifact')
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
               'scope': 'Native RPM reproducibility, Fedora dependency provisioning, then existing-base install/upgrade/removal',
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

    def write_json(name, value):
        (output / name).write_text(json.dumps(value, indent=2) + '\n')

    def inventory(label):
        result = run('rpm', '-qa', '--qf', '%{NAME}\t%{EPOCHNUM}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\t%{SOURCERPM}\n')
        (output / f'packages-{label}.tsv').write_text(
            'name\tepoch\tversion\trelease\tarchitecture\tsource_rpm\n' +
            '\n'.join(sorted(result.stdout.splitlines())) + '\n')

    def preservation_snapshot(label, before, preserved):
        after = {str(path): fingerprint(path) for path in preserved}
        write_json(f'preservation-{label}.json', after)
        changes = changed_paths(before, after)
        write_json(f'preservation-{label}-changes.json', changes)
        inventory(label)
        paths = {entry['path'] for entry in changes}
        for entry in changes:
            for state in (entry['before'], entry['after']):
                if state and isinstance(state.get('symlink'), str):
                    target = Path(state['symlink'])
                    if not target.is_absolute():
                        target = Path(entry['path']).parent / target
                    paths.add(str(target.resolve()))
        ownership, packages = {}, set()
        for path in sorted(paths):
            result = run('rpm', '-qf', '--qf', '%{NAME}\n', path, check=False)
            ownership[path] = {'returncode': result.returncode, 'output': result.stdout}
            if result.returncode == 0:
                packages.update(result.stdout.splitlines())
        write_json(f'preservation-{label}-ownership.json', ownership)
        provenance = {}
        for package in sorted(packages):
            provenance[package] = {}
            for option in ('--scripts', '--triggers'):
                result = run('rpm', '-q', option, package, check=False)
                provenance[package][option] = {'returncode': result.returncode, 'output': result.stdout}
        write_json(f'preservation-{label}-package-scriptlets.json', provenance)
        return after

    try:
        record = args.runtime / 'source.json'
        assert record.is_file() and not record.is_symlink()
        runtime = json.loads(record.read_text())
        assert set(runtime['files']) == {'harness-tui', 'cli.js', 'notify.mjs'}
        for name, entry in runtime['files'].items():
            path = args.runtime / name
            assert path.is_file() and not path.is_symlink()
            assert path.stat().st_size == entry['bytes'] and digest(path) == entry['sha256']
        first, old = identity(args.first, args.source, args.runtime_source, runtime)
        repeat, repeated = identity(args.repeat, args.source, args.runtime_source, runtime)
        upgrade, new = identity(args.upgrade, args.source, args.runtime_source, runtime)
        assert old['runtime_identity_sha256'] == repeated['runtime_identity_sha256'] == new['runtime_identity_sha256'] == digest(record)
        assert first.read_bytes() == repeat.read_bytes(), 'Same inputs produced different RPM bytes'
        assert old['files'] == repeated['files'] == new['files']
        assert old['symlinks'] == repeated['symlinks'] == new['symlinks']
        assert old['package']['version'] == new['package']['version']
        assert str(old['package']['release']) == '1' and str(new['package']['release']) == '2'
        requirements = {}
        for label, rpm in (('first', first), ('upgrade', upgrade)):
            assert not run('rpm', '-qp', '--scripts', rpm).stdout.strip(), 'Package contains service/account scriptlets'
            assert not run('rpm', '-qp', '--triggers', rpm).stdout.strip(), 'Package contains transaction triggers'
            required = run('rpm', '-qp', '--requires', rpm).stdout
            (output / f'package-requires-{label}.txt').write_text(required)
            requirements[label] = [line for line in required.splitlines() if not line.startswith('rpmlib(')]
        assert requirements['first'] == requirements['upgrade'], 'Upgrade changes platform requirements'
        receipt['packages'] = {'first': old, 'upgrade': new}
        receipt['checks'].append('Independent same-input builds produce identical RPM bytes; upgrade changes only RPM release')

        # Fedora dependencies apply their own normal presets. Retain that full
        # configuration delta separately from the Harness lifecycle baseline.
        manager = shutil.which('dnf5') or shutil.which('microdnf')
        assert manager, 'The locked Fedora image must provide a package manager'
        manager_options = [manager, '-y', '--setopt=install_weak_deps=False',
                           '--setopt=gpgcheck=True', '--nodocs']
        assert run('rpm', '-q', 'harness-os-session', check=False).returncode == 1
        dependency_before = {'/etc': fingerprint(Path('/etc'))}
        write_json('preservation-before-dependencies.json', dependency_before)
        inventory('before-dependencies')
        try:
            run(*manager_options, 'install', *requirements['first'], timeout=600)
        finally:
            dependency_after = {'/etc': fingerprint(Path('/etc'))}
            write_json('preservation-after-dependencies.json', dependency_after)
            write_json('preservation-dependency-changes.json', changed_paths(dependency_before, dependency_after))
            inventory('after-dependencies')
        assert run('rpm', '-q', 'harness-os-session', check=False).returncode == 1
        receipt['checks'].append('Signed Fedora requirements provisioned with normal presets; configuration delta retained and Harness absent')

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
        mask = home / '.config/systemd/user/pipewire.service'
        mask.parent.mkdir(parents=True, exist_ok=True)
        mask.symlink_to('/dev/null')  # Preserve this user's explicit service choice.
        run('chown', '-h', '-R', 'harness-rpm-probe:harness-rpm-probe', home)
        preserved = [home, Path('/etc/profile.d/harness-os.sh'), Path('/etc/NetworkManager/conf.d/10-dns.conf'),
                     Path('/etc/systemd/system/getty@tty1.service.d'), Path('/etc/systemd/system/default.target'),
                     Path('/etc/systemd/user/default.target.wants'), Path('/etc/hostname'), Path('/etc/hosts'),
                     Path('/etc/sudoers.d/99-harness-update-test')]
        before = {str(path): fingerprint(path) for path in preserved}
        write_json('preservation-before.json', before)
        inventory('before')
        account = run('getent', 'passwd', 'harness-rpm-probe').stdout
        transaction = [*manager_options, '--setopt=localpkg_gpgcheck=False', 'install']
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
            agent = metadata['agent']
            assert agent == json.loads(Path('/usr/share/harness-os/opencode.json').read_text())
            # OpenCode initializes XDG directories even for --version. Keep
            # this executable probe separate from the existing-user snapshot,
            # which must measure only the RPM transaction's effects.
            with tempfile.TemporaryDirectory(prefix='harness-agent-version-') as temporary:
                run('chown', 'harness-rpm-probe:harness-rpm-probe', temporary)
                environment = ['HOME=' + temporary, *['XDG_' + kind.upper() + '_HOME=' + temporary + '/' + kind
                               for kind in ['config', 'data', 'cache', 'state']]]
                assert run('runuser', '-u', 'harness-rpm-probe', '--', 'env', *environment,
                           '/usr/bin/opencode', '--version', timeout=30).stdout.strip() == agent['version']
                # Exercise the distribution compositor with only the RPM's
                # declared dependencies. Merely resolving labwc's libraries
                # misses its mandatory Xwayland executable at startup.
                run('runuser', '-u', 'harness-rpm-probe', '--', 'env', *environment,
                    'XDG_RUNTIME_DIR=' + temporary, 'WLR_BACKENDS=headless',
                    'WLR_RENDERER=pixman', 'labwc', '-C', temporary,
                    '-S', '/usr/bin/true', timeout=30)
            assert run('rpm', '-qf', '--qf', '%{NAME}', '/usr/bin/opencode').stdout == 'harness-os-session'
            assert run('rpm', '-qf', '--qf', '%{NAME}', '/usr/lib/harness-opencode/opencode').stdout == 'harness-os-session'
            assert '/usr/share/licenses/harness-opencode/LICENSE' in installed
            owners = run('rpm', '-q', '--qf', '[%{FILEUSERNAME}\t%{FILEGROUPNAME}\n]', 'harness-os-session').stdout
            assert all(line == 'root\troot' for line in owners.splitlines())
            after = preservation_snapshot('after-' + label, before, preserved)
            assert after == before, 'Existing user/login/network policy changed'
            assert run('getent', 'passwd', 'harness-rpm-probe').stdout == account
            assert run('getent', 'passwd', 'me', check=False).returncode != 0, 'Package created a default OS account'
            receipt['checks'].append(f'Native {label}: declared payload owned/verified, existing user and host configuration unchanged')
            receipt['checks'].append(f'Native {label}: packaged dependencies start the distribution compositor on a headless Wayland backend')
        # A plain RPM erase is intentional: dependency autoremoval is a separate
        # DNF policy and must not disguise removal of this package's own files.
        run('rpm', '-e', 'harness-os-session')
        assert run('rpm', '-q', 'harness-os-session', check=False).returncode != 0
        for relative in [*new['files'], *new['symlinks']]:
            path = Path('/') / relative
            assert not path.exists() and not path.is_symlink(), 'RPM left an owned file: ' + relative
        after = preservation_snapshot('after-removal', before, preserved)
        assert after == before
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
