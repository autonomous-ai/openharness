#!/usr/bin/env python3
"""Apply a local Harness development bundle, retaining an offline rollback package."""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid

STATE = Path('/var/lib/harness-os/runtime-updates')
RUNTIME = Path('/usr/share/harness-os/runtime.json')
LOCK = Path('/usr/share/harness-os/lock.json')
PACKAGE_DB = Path('/var/lib/pacman/local')
RESTART_REQUIRED = Path('/run/harness-os-restart-required')
BOOTSTRAP_FILES = ('apply-update.py', 'boot_profile.py', 't2_install.py',
                   't2_firmware.py', 'firmware_names.py', 't2_update.py', 't2_kernel.py')


def digest(path):
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def now():
    return datetime.now(timezone.utc).isoformat()


def system_module():
    # The standalone bootstrap runs on preview 4 before this module is installed.
    path = Path('/usr/lib/harness-os/system.py')
    spec = importlib.util.spec_from_file_location('harness_os_system', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def boot_module():
    spec = importlib.util.spec_from_file_location('harness_boot_profile', Path(__file__).with_name('boot_profile.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or '..' in path.parts or not path.parts or str(path) != value.rstrip('/'):
        raise ValueError('Invalid package path: ' + value)
    return path


def inspect_package(path, version, runtime=None):
    """Check package identity and contents without extracting or running anything."""
    with tarfile.open(path, 'r:gz') as archive:
        members = {}
        for member in archive:
            name = str(relative_path(member.name))
            if name in members:
                raise ValueError('Duplicate package path: ' + name)
            if not (member.isfile() or member.isdir() or member.issym()):
                raise ValueError('Unsupported package entry: ' + name)
            if name != '.PKGINFO' and PurePosixPath(name).parts[0] not in ('etc', 'usr'):
                raise ValueError('Package may only change Harness system files: ' + name)
            if member.issym():
                target = PurePosixPath(member.linkname)
                if target.is_absolute() or '..' in target.parts:
                    raise ValueError('Unsafe package link: ' + name)
            if member.uid != 0 or member.gid != 0:
                raise ValueError('Package files must belong to root.')
            members[name] = member
        # A link must never redirect a later member during pacman's extraction.
        for name in members:
            for parent in PurePosixPath(name).parents:
                if str(parent) in members and members[str(parent)].issym():
                    raise ValueError('Package path traverses a link: ' + name)
        metadata = members.get('.PKGINFO')
        if metadata is None or not metadata.isfile() or metadata.size > 65536:
            raise ValueError('Missing or invalid package metadata.')
        fields = {}
        for line in archive.extractfile(metadata).read().decode().splitlines():
            if ' = ' in line:
                key, value = line.split(' = ', 1)
                fields.setdefault(key, []).append(value)
        if any(fields.get(key) != [value] for key, value in
               [('pkgname', 'harness-os'), ('pkgver', version), ('arch', 'x86_64')]):
            raise ValueError('Package identity does not match its manifest.')
        if runtime is not None:
            member = members.get('usr/share/harness-os/runtime.json')
            if member is None or not member.isfile() or member.size > 65536:
                raise ValueError('Missing runtime identity.')
            if json.load(archive.extractfile(member)) != runtime:
                raise ValueError('Runtime identity does not match its manifest.')
            for name, info in runtime['files'].items():
                if str(relative_path(name)) != Path(name).name:
                    raise ValueError('Invalid runtime filename.')
                member = members.get('usr/lib/harness/' + name)
                if member is None or not member.isfile() or member.size != info['bytes']:
                    raise ValueError('Missing or truncated runtime: ' + name)
                if hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest() != info['sha256']:
                    raise ValueError('Runtime checksum mismatch: ' + name)


def validate_base(manifest, base):
    if not isinstance(manifest, dict) or manifest.get('schema') != 1 or manifest.get('kind') != 'harness-os-package':
        raise ValueError('Not a Harness package bundle.')
    base_identity = {'version': base['version'], 'arch_snapshot': base['arch_snapshot']}
    same_base = manifest.get('requires_os_version') == base['version'] and manifest.get('arch_snapshot') == base['arch_snapshot']
    migrations = manifest.get('upgrades_from', [])
    if not isinstance(migrations, list) or len(migrations) > 32 or any(
        not isinstance(item, dict) or set(item) != {'version', 'arch_snapshot'} or
        not isinstance(item['version'], str) or not isinstance(item['arch_snapshot'], str) for item in migrations
    ):
        raise ValueError('Invalid system migration list.')
    migration = base_identity in migrations
    if manifest.get('architecture') != 'x86_64' or not (same_base or migration):
        raise ValueError('This package requires a different Harness base image or architecture.')


def validate_bundle(folder, base):
    manifest = read_json(folder / 'package-manifest.json')
    validate_base(manifest, base)
    commit = manifest.get('source_commit', '')
    runtime = manifest.get('runtime', {})
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or runtime.get('source_commit') != commit or runtime.get('dirty') is not False or runtime.get('target') != 'x86_64-unknown-linux-musl':
        raise ValueError('The bundle must identify a clean Linux x86-64 source build.')
    if set(runtime.get('files', {})) != {'harness-tui', 'cli.mjs', 'notify.mjs'}:
        raise ValueError('The bundle must include the complete Harness runtime.')
    package = manifest.get('package', {})
    name = package.get('name', '')
    version = package.get('version', '')
    if not re.fullmatch(r'[0-9A-Za-z.+_-]+', version) or name != f'harness-os-{version}-x86_64.pkg.tar.gz':
        raise ValueError('Invalid package name or version.')
    path = folder / name
    if path.is_symlink() or not path.is_file() or package.get('bytes') != path.stat().st_size or digest(path) != package.get('sha256'):
        raise ValueError('Package checksum or size mismatch; download the complete bundle again.')
    inspect_package(path, version, runtime)
    boot_module().validate_update(path, allow_kernel_change=True)
    return manifest, path


def installed_version():
    value = subprocess.check_output(['pacman', '-Q', 'harness-os'], text=True).strip().split()
    if len(value) != 2 or value[0] != 'harness-os' or not re.fullmatch(r'[0-9A-Za-z.+_-]+', value[1]):
        raise ValueError('Cannot identify the installed Harness package.')
    return value[1]


def prepare_kernel_bundle(folder):
    """Finish T2 downloads before the public updater advances any Arch packages."""
    manifest = read_json(folder / 'package-manifest.json')
    with tempfile.TemporaryDirectory(prefix='.kernels-', dir=folder) as temp:
        staging = Path(temp)
        change = boot_module().prepare_update(folder / manifest['package']['name'], folder, staging)
        if change:
            for pin in (change['previous'], change['candidate']):
                name = pin['package']['filename']
                (staging / name).replace(folder / name)


def verify_runtime(expected):
    if read_json(RUNTIME) != expected:
        raise ValueError('Installed runtime identity differs from the expected package.')
    for name, info in expected['files'].items():
        path = Path('/usr/lib/harness') / name
        if path.stat().st_size != info['bytes'] or digest(path) != info['sha256']:
            raise ValueError('Installed runtime verification failed: ' + name)


def package_backup(snapshot_root, version, output):
    """Rebuild this one installed package from the pre-update read-only snapshot."""
    db = snapshot_root / str(PACKAGE_DB).lstrip('/') / ('harness-os-' + version)
    fields = {}
    for block in (db / 'desc').read_text().strip().split('\n\n'):
        lines = block.splitlines()
        fields[lines[0].strip('%')] = lines[1:]
    if fields.get('NAME') != ['harness-os'] or fields.get('VERSION') != [version] or (db / 'install').exists():
        raise ValueError('Unexpected installed package metadata; use checkpoint recovery instead.')
    mapping = {'NAME': 'pkgname', 'BASE': 'pkgbase', 'VERSION': 'pkgver', 'DESC': 'pkgdesc',
               'URL': 'url', 'ARCH': 'arch', 'BUILDDATE': 'builddate', 'PACKAGER': 'packager',
               'SIZE': 'size', 'LICENSE': 'license', 'DEPENDS': 'depend',
               'OPTDEPENDS': 'optdepend', 'PROVIDES': 'provides', 'CONFLICTS': 'conflict',
               'REPLACES': 'replaces', 'GROUPS': 'group', 'XDATA': 'xdata'}
    metadata = ''.join(f'{target} = {value}\n' for key, target in mapping.items() for value in fields.get(key, []))
    blocks = {}
    for block in (db / 'files').read_text().strip().split('\n\n'):
        lines = block.splitlines()
        blocks[lines[0].strip('%')] = lines[1:]
    for backup in blocks.get('BACKUP', []):
        metadata += 'backup = ' + backup.split('\t')[0] + '\n'
    with tarfile.open(output, 'w:gz', dereference=False, compresslevel=6) as archive:
        info = tarfile.TarInfo('.PKGINFO')
        data = metadata.encode()
        info.size, info.mode = len(data), 0o644
        archive.addfile(info, io.BytesIO(data))
        for name in blocks['FILES']:
            path = relative_path(name)
            if path.parts[0] not in ('etc', 'usr'):
                raise ValueError('Unexpected installed package path: ' + name)
            # recursive=False is essential: shared directories contain other packages.
            archive.add(snapshot_root / str(path), arcname=str(path), recursive=False)
    inspect_package(output, version)


def latest():
    pointer = STATE / 'latest.json'
    if not pointer.exists():
        return None
    identity = read_json(pointer)['id']
    if not isinstance(identity, str) or not re.fullmatch(r'[0-9TZ-]+-[a-f0-9]{8}', identity):
        raise ValueError('Invalid update receipt identifier.')
    receipt = read_json(STATE / identity / 'receipt.json')
    if receipt.get('id') != identity:
        raise ValueError('Update receipt identity mismatch.')
    return receipt


def install_package(package, version, runtime, additional=()):
    # The caller already holds the system-operation lock and made its checkpoint.
    # Keep pacman's own lock and other hooks; suppress only our duplicate checkpoint.
    subprocess.run(['pacman', '--noconfirm', '-U', *map(str, additional), str(package)], check=True,
                   env=dict(os.environ, HN_OS_UPDATE_CHECKPOINT='1'))
    if installed_version() != version:
        raise ValueError('The installed package version did not change as expected.')
    verify_runtime(runtime)


def prepare_packages(package, additional=()):
    # Resolve and verify the entire transaction while the old installation is
    # still intact. Pacman retains signatures/dependency checks, and uses its
    # cache when offline. Missing downloads must not create a failed checkpoint.
    subprocess.run(['pacman', '--noconfirm', '-U', '--downloadonly',
                    *map(str, additional), str(package)], check=True)


class Steps:
    """`Step 2 of 4 · Saving a recovery point…` in the Updates terminal. A system update showed
    pacman's output alone, with no sign of how far it was or that turning the computer off
    then is the one moment that leaves it to recovery."""

    def __init__(self, total):
        self.total, self.done = total, 0

    def __call__(self, text):
        self.done += 1
        self.total = max(self.total, self.done)
        print(f'Step {self.done} of {self.total} · {text}…', flush=True)


def apply(folder, system, base, installation, steps=None):
    steps = steps or Steps(3)
    previous = latest()
    if previous and previous['status'] not in ('applied', 'rolled-back'):
        raise ValueError('The previous Harness update did not finish. Run rollback first; its checkpoint is retained.')
    manifest, source_package = validate_bundle(folder, base)
    boot = boot_module()
    target_date = system.snapshot_date(manifest['arch_snapshot'])
    if target_date > base['arch_snapshot']:
        dates = set(re.findall(r'https://archive\.archlinux\.org/repos/(\d{4}/\d{2}/\d{2})/', system.PACMAN_CONFIG.read_text()))
        if len(dates) != 1 or next(iter(dates)) < target_date or system.pending_update():
            raise ValueError('Complete the full system upgrade to ' + target_date + ' before installing this package.')
    old_version, old_runtime = installed_version(), read_json(RUNTIME)
    if old_version == manifest['package']['version']:
        verify_runtime(manifest['runtime'])
        print('This Harness build is already installed.')
        return
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE.chmod(0o700)
    # Copy before mutation; a user-owned download may change while it is being read.
    # Stage outside the root subvolume: a kernel download must not be copied
    # into every root checkpoint in addition to the retained rollback package.
    with tempfile.TemporaryDirectory(prefix='.harness-incoming-', dir=system.CHECKPOINTS) as temp:
        incoming = Path(temp)
        shutil.copyfile(source_package, incoming / source_package.name)
        system.write_json(incoming / 'package-manifest.json', manifest)
        validate_bundle(incoming, base)
        kernel_change = boot.prepare_update(incoming / source_package.name, folder, incoming)
        kernel = boot.module('t2_update') if kernel_change else None
        additional = [incoming / kernel_change['candidate']['package']['filename']] if kernel_change else []
        prepare_packages(incoming / source_package.name, additional)
        steps('Saving a recovery point')
        checkpoint = system.checkpoint('before-harness-update')
        identity = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
        saved = STATE / identity
        saved.mkdir(mode=0o700)
        backup = saved / 'previous.pkg.tar.gz'
        package_backup(system.CHECKPOINTS / checkpoint / 'root', old_version, backup)
        with backup.open('rb') as handle:
            os.fsync(handle.fileno())
        if kernel_change:
            kernel.retain(kernel_change, incoming, saved)
        receipt = {'id': identity, 'status': 'applying', 'started_at': now(),
                   'root_uuid': installation['root_uuid'], 'checkpoint': checkpoint,
                   'previous_version': old_version, 'previous_runtime': old_runtime,
                   'backup_sha256': digest(backup), 'candidate': manifest}
        if kernel_change:
            receipt['kernel_update'] = kernel_change
        system.write_json(saved / 'receipt.json', receipt)
        system.write_json(STATE / 'latest.json', {'id': identity})
        try:
            # The fast user updater must not mix a running old session with newly
            # installed OS integration. /run clears this only on a real reboot.
            system.write_json(RESTART_REQUIRED, {'status': 'applying', 'package': manifest['package']['version']})
            steps('Installing Harness')
            install_package(incoming / source_package.name, manifest['package']['version'], manifest['runtime'], additional)
            steps('Preparing the boot files')
            boot.restore_firmware()
            # Plymouth and other initramfs assets may change without a kernel
            # package transaction, so rebuild them on this path as well.
            system.run('mkinitcpio', '-P')
            if kernel_change:
                system.run('grub-mkconfig', '-o', '/boot/grub/grub.cfg')
                kernel.verify(kernel_change['candidate'], kernel_change['candidate_files'])
        except BaseException:
            receipt.update(status='failed', finished_at=now())
            system.write_json(saved / 'receipt.json', receipt)
            system.write_json(RESTART_REQUIRED, {'status': 'failed'})
            print('Update did not complete. Roll back with this same updater; the original checkpoint is retained.', file=sys.stderr)
            raise
        receipt.update(status='applied', finished_at=now())
        system.write_json(saved / 'receipt.json', receipt)
        system.write_json(RESTART_REQUIRED, {'status': 'ready', 'package': manifest['package']['version']})
    print('Harness updated. Reboot when ready to use the new session. Your running work has not been restarted.')


def rollback(system, installation):
    receipt = latest()
    if not receipt:
        raise ValueError('No Harness update is available to roll back.')
    if receipt['root_uuid'] != installation['root_uuid']:
        raise ValueError('This update belongs to a different installation.')
    if receipt['status'] == 'rolled-back':
        print('The previous Harness build is already restored.')
        return
    folder = STATE / receipt['id']
    backup = folder / 'previous.pkg.tar.gz'
    if digest(backup) != receipt['backup_sha256']:
        raise ValueError('Rollback package checksum mismatch. Recover the recorded checkpoint from the live USB.')
    inspect_package(backup, receipt['previous_version'], receipt['previous_runtime'])
    # A legacy PC rollback removes the new platform helpers from disk. Retain
    # the loaded helper until this transaction finishes using it.
    boot = boot_module()
    change = receipt.get('kernel_update')
    boot.validate_update(backup, allow_kernel_change=bool(change), kernel_rollback=bool(change))
    kernel = boot.module('t2_update') if change else None
    # Verify the retained archive and matching previous Harness pin before
    # recording rollback or touching pacman's database. No network is needed.
    additional = [kernel.rollback(change, folder, backup)] if change else []
    receipt.update(status='rolling-back', rollback_started_at=now())
    system.write_json(folder / 'receipt.json', receipt)
    system.write_json(RESTART_REQUIRED, {'status': 'failed'})
    install_package(backup, receipt['previous_version'], receipt['previous_runtime'], additional)
    boot.restore_firmware()
    system.run('mkinitcpio', '-P')
    if change:
        system.run('grub-mkconfig', '-o', '/boot/grub/grub.cfg')
        kernel.verify(change['previous'], change['previous_files'])
    receipt.update(status='rolled-back', rollback_finished_at=now())
    system.write_json(folder / 'receipt.json', receipt)
    system.write_json(RESTART_REQUIRED, {'status': 'ready', 'package': receipt['previous_version']})
    print('Previous Harness build restored. Reboot when ready to use it.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('apply').add_argument('bundle', type=Path)
    commands.add_parser('rollback')
    commands.add_parser('status')
    args = parser.parse_args(argv)
    if os.geteuid() != 0:
        parser.error('Run with sudo on the installed Harness machine.')
    if platform.system() != 'Linux' or platform.machine() != 'x86_64' or Path('/etc/harness-live').exists():
        parser.error('Use an installed x86-64 Harness system, not the live USB.')
    system = system_module()
    with system.operation_lock():
        installation = system.installed()
        if args.command == 'status':
            print(json.dumps({'version': installed_version(), 'runtime': read_json(RUNTIME), 'last_update': latest()}, indent=2))
            return
        if system.pending_update():
            raise ValueError('Complete the pending Arch system update before changing the Harness package.')
        if args.command == 'apply':
            apply(args.bundle.resolve(), system, read_json(LOCK), installation)
        else:
            rollback(system, installation)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError, tarfile.TarError) as error:
        raise SystemExit('Harness update stopped: ' + str(error))
