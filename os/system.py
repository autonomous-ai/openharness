#!/usr/bin/env python3
"""Explicit OS updates and offline recovery. No updater daemon or scheduled downloads."""
from __future__ import annotations
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import uuid

PACMAN_CONFIG = Path('/etc/pacman.conf')
UPDATE_RECEIPT = Path('/var/lib/harness-os/update.json')
CHECKPOINTS = Path('/.snapshots')


def boot_module():
    spec = importlib.util.spec_from_file_location('harness_boot_profile', Path(__file__).with_name('boot_profile.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(*args, capture=False):
    return subprocess.run([str(a) for a in args], check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + '.new')
    with temporary.open('w') as handle:
        handle.write(json.dumps(data, indent=2) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def pending_update():
    if not UPDATE_RECEIPT.exists():
        return None
    receipt = read_json(UPDATE_RECEIPT)
    if not isinstance(receipt, dict):
        raise ValueError('Invalid system-update receipt; inspect it before changing packages.')
    if receipt.get('exit_status') == 0:
        return None
    if not isinstance(receipt.get('snapshot'), str) or not isinstance(receipt.get('checkpoint'), str):
        raise ValueError('Incomplete system-update receipt; use the live USB to inspect recovery checkpoints.')
    checkpoint_name(receipt['checkpoint'])
    return receipt


def snapshot_date(value):
    try:
        date = datetime.strptime(value, '%Y/%m/%d').date()
    except ValueError as error:
        raise argparse.ArgumentTypeError('Use an Arch snapshot date in YYYY/MM/DD form.') from error
    if value != date.strftime('%Y/%m/%d') or date >= datetime.now(timezone.utc).date():
        raise argparse.ArgumentTypeError('Use a complete dated repository snapshot before today.')
    return value


def checkpoint_name(value):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}', value):
        raise ValueError('Invalid checkpoint name.')
    return value


def validate_checkpoint(meta, root_uuid):
    if meta.get('root_uuid') != root_uuid:
        raise ValueError('Checkpoint belongs to a different root filesystem.')
    if not re.fullmatch(r'[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}', meta.get('boot_uuid', '')):
        raise ValueError('Checkpoint has an invalid boot partition identifier.')
    required = boot_module().boot_files(meta.get('platform', 'pc'))
    if not required.issubset(meta.get('boot_sha256', {})):
        raise ValueError('Checkpoint is missing the kernel, initramfs or boot configuration.')


def physical_disks(device):
    data = json.loads(run('lsblk', '--inverse', '--json', '--paths', '--output', 'NAME,TYPE', device, capture=True))
    def collect(node):
        result = {node['name']} if node['type'] == 'disk' else set()
        for child in node.get('children', []):
            result.update(collect(child))
        return result
    result = set()
    for node in data['blockdevices']:
        result.update(collect(node))
    return result


@contextmanager
def operation_lock():
    with open('/run/lock/hn-os.lock', 'w') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError('Another hn-os system operation is running.') from error
        yield


def boot_hashes(folder):
    result = {}
    for path in sorted(folder.rglob('*')):
        if path.is_file():
            with path.open('rb') as handle:
                result[str(path.relative_to(folder))] = hashlib.file_digest(handle, 'sha256').hexdigest()
    return result


def installed():
    receipt = Path('/var/lib/harness-os/install.json')
    if not receipt.is_file() or run('findmnt', '-n', '-o', 'FSTYPE', '/', capture=True).strip() != 'btrfs':
        raise ValueError('This operation requires an installed Harness system.')
    info = read_json(receipt)
    for mount in ['/', '/.snapshots']:
        actual = run('findmnt', '-n', '-o', 'UUID', '--mountpoint', mount, capture=True).strip()
        if actual != info['root_uuid']:
            raise ValueError(f'{mount} is not on the installed system filesystem.')
    if run('findmnt', '-n', '-o', 'UUID', '--mountpoint', '/boot', capture=True).strip() != info['boot_uuid']:
        raise ValueError('The matching boot partition must be mounted before making a checkpoint.')
    return info


def checkpoint(reason='manual', pacman_hook=False):
    if pacman_hook and pending_update():
        raise ValueError('A full system update did not finish. Run sudo hn-os update to complete it before changing packages, or recover its checkpoint from the live USB.')
    info = installed()
    platform = boot_module().selected()
    if info.get('platform', 'pc') != platform['id']:
        raise ValueError('The installed system and its boot platform differ.')
    if platform['id'] == 'apple-t2':
        boot_module().module('t2_install').retained()
    if Path('/var/lib/pacman/db.lck').exists() and not pacman_hook:
        raise ValueError('Wait for the active package transaction before making a checkpoint.')
    name = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    base = CHECKPOINTS
    pending = base / ('.' + name + '.pending')
    pending.mkdir(mode=0o700)
    try:
        run('sync')
        run('btrfs', 'subvolume', 'snapshot', '-r', '/', pending / 'root')
        shutil.copytree('/boot', pending / 'boot')
        metadata = {'name': name, 'created_at': datetime.now(timezone.utc).isoformat(),
                    'reason': reason, 'root_uuid': info['root_uuid'], 'boot_uuid': info['boot_uuid'],
                    'boot_sha256': boot_hashes(pending / 'boot'), 'platform': platform['id']}
        validate_checkpoint(metadata, info['root_uuid'])
        write_json(pending / 'checkpoint.json', metadata)
        run('sync')
        pending.rename(base / name)
    except BaseException:
        if (pending / 'root').exists():
            run('btrfs', 'subvolume', 'delete', pending / 'root')
        shutil.rmtree(pending)
        raise
    print(f'Checkpoint {name}', flush=True)
    return name


def advance_snapshot(config, date):
    pattern = re.compile(r'(https://archive\.archlinux\.org/repos/)(\d{4}/\d{2}/\d{2})(/\$repo/os/\$arch)')
    dates = {match.group(2) for match in pattern.finditer(config)}
    if len(dates) != 1:
        raise ValueError('Expected one managed Arch snapshot. Custom mirror setups should use their normal full-upgrade procedure.')
    if date < next(iter(dates)):
        raise ValueError('Use offline checkpoint recovery to go back. Updates must not move the repository date backward.')
    # Preserve user-added repositories, Includes, signature policy and options.
    return pattern.sub(lambda match: match.group(1) + date + match.group(3), config)


def update(date, *, noninteractive=False):
    # Pin every repository to the same date, and perform a full upgrade. Never mix
    # a newly synced package database with an intentionally old installed base.
    config = PACMAN_CONFIG
    advanced = advance_snapshot(config.read_text(), date)
    pending = pending_update()
    if pending:
        # A retry must retain the original good system, not replace its recovery
        # point with a snapshot of a potentially half-upgraded root.
        previous = pending['checkpoint']
        saved = CHECKPOINTS / previous
        validate_checkpoint(read_json(saved / 'checkpoint.json'), installed()['root_uuid'])
        if not (saved / 'root').is_dir():
            raise ValueError('The original update checkpoint is missing; use the live USB for recovery.')
    else:
        previous = checkpoint('before-update')
    receipt = {'snapshot': date, 'checkpoint': previous,
               'started_at': datetime.now(timezone.utc).isoformat(), 'exit_status': None}
    # Persist before changing repositories or invoking pacman. A crash or Ctrl-C
    # leaves this guard in place until a complete upgrade succeeds.
    write_json(UPDATE_RECEIPT, receipt)
    temporary = config.with_suffix('.hn-next')
    temporary.write_text(advanced)
    temporary.chmod(stat.S_IMODE(config.stat().st_mode))
    temporary.replace(config)
    # Both the CLI and the public release updater already hold the operation
    # lock and saved the recovery point. Only this transaction skips our hook.
    command = ['pacman', '-Syyu']
    if noninteractive:
        command.append('--noconfirm')
    result = subprocess.run(command, stdin=subprocess.DEVNULL if noninteractive else None,
                            env=dict(os.environ, HN_OS_UPDATE_CHECKPOINT='1'))
    if result.returncode == 0 and boot_module().selected()['id'] == 'apple-t2':
        # Package updates must not replace Apple board data with generic radio
        # fallbacks. Keep the saved private bundle in the root snapshot too.
        boot_module().restore_firmware()
        run('mkinitcpio', '-P')
        run('grub-mkconfig', '-o', '/boot/grub/grub.cfg')
    receipt.update(finished_at=datetime.now(timezone.utc).isoformat(), exit_status=result.returncode)
    write_json(UPDATE_RECEIPT, receipt)
    if result.returncode:
        raise ValueError(f'Update did not complete. Run sudo hn-os update to retry before changing packages. Checkpoint {previous} is available from the live USB; see hn-os help.')
    print('Update completed. Reboot to use the updated kernel. The previous system is retained in ' + previous)


def mounted_device(device, mountinfo=Path('/proc/self/mountinfo')):
    dev = os.stat(device)
    if not stat.S_ISBLK(dev.st_mode):
        raise ValueError('Select a block device, such as /dev/sda3 or an unlocked /dev/mapper device.')
    identity = f'{os.major(dev.st_rdev)}:{os.minor(dev.st_rdev)}'
    return any(line.split()[2] == identity for line in mountinfo.read_text().splitlines())


def copy_contents(source, destination):
    # These paths are our whole-disk install's boot partition and its checkpoint.
    # FAT has no Unix owners/modes, so restore contents without copying metadata.
    for path in destination.iterdir():
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    for path in source.rglob('*'):
        target = destination / path.relative_to(source)
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def recover(device, name=None):
    device = Path(device).resolve(strict=True)
    if not str(device).startswith('/dev/') or mounted_device(device):
        raise ValueError('Recovery requires an unmounted root device. Boot the live USB first.')
    with tempfile.TemporaryDirectory(prefix='hn-recovery-', dir='/mnt') as temp:
        top = Path(temp)
        boot = top / '.hn-recovery-boot'
        run('mount', '-t', 'btrfs', '-o', 'subvolid=5', device, top)
        boot_mounted = False
        try:
            checkpoints = top / '@snapshots'
            if name is None:
                for meta in sorted(checkpoints.glob('*/checkpoint.json')):
                    item = read_json(meta)
                    print(f'{item["name"]}  {item["created_at"]}  {item["reason"]}')
                return
            chosen = checkpoints / checkpoint_name(name)
            meta = read_json(chosen / 'checkpoint.json')
            actual_uuid = run('blkid', '-s', 'UUID', '-o', 'value', device, capture=True).strip()
            validate_checkpoint(meta, actual_uuid)
            if boot_module().selected(chosen / 'root')['id'] != meta.get('platform', 'pc'):
                raise ValueError('Checkpoint root has a different boot platform.')
            if meta.get('platform', 'pc') == 'apple-t2':
                boot_module().module('t2_install').retained(chosen / 'root')
            if boot_hashes(chosen / 'boot') != meta['boot_sha256']:
                raise ValueError('Checkpoint boot-file checksums do not match. Nothing restored.')
            boot_device = Path('/dev/disk/by-uuid') / meta['boot_uuid']
            roots = physical_disks(device)
            if len(roots) != 1 or roots != physical_disks(boot_device):
                raise ValueError('Root and boot partitions must belong to the same installed disk.')
            if mounted_device(boot_device):
                raise ValueError('The installed boot partition is mounted. Unmount it before recovery.')
            boot.mkdir()
            run('mount', '-t', 'vfat', boot_device, boot)
            boot_mounted = True
            suffix = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
            saved = checkpoints / ('before-recovery-' + suffix)
            restoring = top / ('@restoring-' + suffix)
            saved.mkdir(mode=0o700)
            shutil.copytree(boot, saved / 'boot')
            run('btrfs', 'subvolume', 'snapshot', chosen / 'root', restoring)
            # PreTransaction snapshots contain pacman's active transaction lock.
            # No package manager owns it in this offline recovery candidate.
            (restoring / 'var/lib/pacman/db.lck').unlink(missing_ok=True)
            try:
                copy_contents(chosen / 'boot', boot)
                run('sync')
                if boot_hashes(boot) != meta['boot_sha256']:
                    raise ValueError('Restored boot files failed verification.')
                # A previous interrupted recovery can have moved @ already.
                # A fresh candidate also avoids colliding with its staging subvolume.
                if (top / '@').exists():
                    (top / '@').rename(saved / 'root')
                restoring.rename(top / '@')
            except BaseException:
                copy_contents(saved / 'boot', boot)
                if (saved / 'root').exists() and not (top / '@').exists():
                    (saved / 'root').rename(top / '@')
                if restoring.exists():
                    run('btrfs', 'subvolume', 'delete', restoring)
                raise
            run('sync')
            print(f'Restored {name}; projects in @home were preserved. Remove the USB and reboot.')
            print(f'The replaced system is retained in @snapshots/{saved.name}.')
        finally:
            if boot_mounted:
                run('umount', boot)
            if boot.exists():
                boot.rmdir()
            run('umount', top)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    cp = sub.add_parser('checkpoint', help='Save root and matching boot files before a system change')
    cp.add_argument('--pacman-hook', action='store_true', help=argparse.SUPPRESS)
    up = sub.add_parser('update', help='Checkpoint, then upgrade the whole system to a dated Arch snapshot')
    up.add_argument('--snapshot', type=snapshot_date,
                    default=(datetime.now(timezone.utc).date() - timedelta(days=1)).strftime('%Y/%m/%d'))
    re = sub.add_parser('recover', help='From the live USB, list or restore an offline system checkpoint')
    re.add_argument('device', help='Unmounted root filesystem; unlock LUKS with cryptsetup first if encrypted')
    re.add_argument('checkpoint', nargs='?', help='Omit to list available checkpoints without restoring')
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.error('Run with sudo.')
    # The image builder and initial installer are not installed systems. The hook
    # is inert there; normal users cannot bypass it through a missing mount.
    if args.command == 'checkpoint' and args.pacman_hook:
        if not Path('/var/lib/harness-os/install.json').is_file():
            return
        # hn-os update already holds this lock and made the same checkpoint.
        if os.environ.get('HN_OS_UPDATE_CHECKPOINT') == '1':
            return
    with operation_lock():
        if args.command == 'checkpoint':
            checkpoint('before-packages' if args.pacman_hook else 'manual', args.pacman_hook)
        elif args.command == 'update':
            update(args.snapshot)
        else:
            recover(args.device, args.checkpoint)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, OSError, KeyboardInterrupt) as error:
        raise SystemExit(f'System operation stopped: {error}')
