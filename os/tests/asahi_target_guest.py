#!/usr/bin/env python3
"""Owned VM-only GPT fixture; never run against a host or an existing Mac disk."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location('target', '/var/tmp/harness-asahi-target.py')
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)
DISK = '/dev/vdb'
ROOT = Path('/mnt/harness-asahi-target')
PLAN = ROOT / 'asahi/harness-install/target.json'
BASELINE = Path('/var/tmp/harness-target-baseline.json')
RESULT = Path('/var/tmp/harness-target-result.json')
ESP = 'e51d26b0-4c8f-41fb-9d83-a0fdd62327c0'
APFS = '7c3457ef-0000-11aa-aa11-00306543ecac'
RECOVERY = '52637672-7900-11aa-aa11-00306543ecac'
GiB = 1024**3 // 4096
MiB = 1024**2 // 4096
PROTECTED = [1, 3, 4]
FILES = ['m1n1/boot.bin', 'vendorfw/fixture.bin', 'asahi/stub_info.json']


def run(*args):
    completed = subprocess.run(list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    if completed.returncode:
        raise RuntimeError(f'{args[0]}: {completed.returncode}: {completed.stderr.decode(errors="replace")}')
    return completed.stdout.decode().strip()


def digest(path):
    result = hashlib.sha256()
    with open(path, 'rb') as handle:
        while data := handle.read(1024**2):
            result.update(data)
    return result.hexdigest()


def guard():
    assert os.geteuid() == 0 and run('uname', '-m') == 'aarch64'
    assert run('getconf', 'PAGESIZE') == '16384'
    assert run('findmnt', '-no', 'SOURCE', '/') == '/dev/vda'
    assert run('lsblk', '-ndo', 'SERIAL', DISK) == 'HARNESS_ENCRYPT_TEST'
    assert run('blockdev', '--getss', DISK) == '4096'
    assert run('blockdev', '--getsize64', DISK) == str(24 * 1024**3)
    assert os.readlink('/proc/self/ns/mnt') != os.readlink('/proc/1/ns/mnt')
    assert run('findmnt', '-nro', 'PROPAGATION', '/') == 'private'
    ROOT.mkdir(exist_ok=True)
    # QEMU does not have Apple's firmware device-tree handoff. This is the only
    # production dependency substituted in the native test. Portable tests cover
    # that reader's actual format/architecture checks; hardware remains separate.
    target.platform_esp = lambda: ESP


def mount():
    run('mount', '-t', 'vfat', '-o', 'rw,noatime,uid=0,gid=0,fmask=0177,dmask=0077', DISK + '2', ROOT)


def metadata():
    length = 24 * 1024**3
    with open(DISK, 'rb', buffering=0) as handle:
        return hashlib.sha256(os.pread(handle.fileno(), 6 * 4096, 0) +
                              os.pread(handle.fileno(), 5 * 4096, length - 5 * 4096)).hexdigest()


def protected():
    with open(DISK, 'rb', buffering=0) as handle:
        entries = {str(n): os.pread(handle.fileno(), 128, 2 * 4096 + (n - 1) * 128).hex() for n in range(1, 5)}
    return {'partitions': {str(n): digest(DISK + str(n)) for n in PROTECTED},
            'esp_files': {name: digest(ROOT / name) for name in FILES},
            'esp_volume_uuid': run('blkid', '-s', 'UUID', '-o', 'value', DISK + '2'),
            'original_gpt_entries': entries}


def initialize():
    assert not BASELINE.exists()
    assert not run('lsblk', '-nro', 'MOUNTPOINTS', DISK)
    run('sgdisk', '--zap-all', DISK)
    run('sgdisk', '--clear',
        f'--new=1:{MiB}:{33 * MiB - 1}', f'--typecode=1:{APFS}', '--change-name=1:macOS fixture',
        f'--new=2:{64 * MiB}:{320 * MiB - 1}', f'--typecode=2:{target.EFI}', f'--partition-guid=2:{ESP}', '--change-name=2:Asahi',
        f'--new=3:{20 * GiB}:{20 * GiB + 32 * MiB - 1}', f'--typecode=3:{RECOVERY}', '--change-name=3:Recovery fixture',
        f'--new=4:{22 * GiB}:{22 * GiB + 64 * MiB - 1}', f'--typecode=4:{target.EFI}', '--change-name=4:Other OS fixture', DISK)
    run('udevadm', 'settle', '--timeout=10')
    for number in PROTECTED:
        device = DISK + str(number)
        size = int(run('blockdev', '--getsize64', device))
        with open(device, 'r+b', buffering=0) as handle:
            os.pwrite(handle.fileno(), bytes([number]) * 65536, 0)
            os.pwrite(handle.fileno(), bytes([number + 32]) * 65536, size - 65536)
            os.fsync(handle.fileno())
    run('mkfs.vfat', '-F', '32', '-n', 'ASAHI_TEST', DISK + '2')
    mount()
    for name in FILES:
        path = ROOT / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('Existing Asahi fixture bytes: ' + name + '\n')
    PLAN.parent.mkdir(mode=0o700)
    baseline = protected()
    baseline.update(table=target.read_table(DISK), started_at=time.time())
    BASELINE.write_text(json.dumps(baseline, indent=2) + '\n')
    target.save_plan(PLAN, target.discover())
    assert protected() == {k: v for k, v in baseline.items() if k not in ('table', 'started_at')}
    plan = target.load_plan(PLAN)
    assert len(target.remaining(plan, target.read_table(DISK))) == 2
    run('umount', ROOT)
    return {'phase': 'prepared', 'plan': plan, 'protected': baseline}


def interrupt():
    mount()
    before = metadata()
    # The persistent record cannot be replaced by an ephemeral copy on /tmp.
    outside_directory = Path('/var/tmp/harness-ephemeral-plan')
    outside_directory.mkdir(mode=0o700)
    outside = outside_directory / 'target.json'
    outside.write_bytes(PLAN.read_bytes())
    outside.chmod(0o600)
    try:
        target.apply_plan(outside)
        raise AssertionError('Accepted an ephemeral installation plan')
    except target.TargetError as error:
        assert 'EFI partition' in str(error)
    assert metadata() == before
    command = target.command
    def stop_after_committed_partition(*args):
        result = command(*args)
        if args[0] == 'sgdisk' and any(str(arg).startswith('--new=') for arg in args):
            # Exit the actual installer process after one completed GPT write;
            # leave its saved plan and table for the next boot to discover.
            os._exit(75)
        return result
    target.command = stop_after_committed_partition
    target.apply_plan(PLAN)
    raise AssertionError('The interruption was not exercised')


def resume():
    mount()
    baseline = json.loads(BASELINE.read_text())
    expected = {k: v for k, v in baseline.items() if k not in ('table', 'started_at')}
    plan = target.load_plan(PLAN)
    missing = target.remaining(plan, target.read_table(DISK))
    assert len(missing) == 1 and missing[0] == plan['additions'][1]
    assert protected() == expected
    applied = target.apply_plan(PLAN)
    assert applied == plan and not target.remaining(plan, target.read_table(DISK))
    assert protected() == expected
    for part in plan['additions']:
        block = Path('/sys/class/block') / Path(part['node']).name
        assert int((block / 'start').read_text()) * 512 == part['start'] * 4096
        assert int((block / 'size').read_text()) * 512 == part['size'] * 4096
        assert run('blkid', '-s', 'PARTUUID', '-o', 'value', part['node']) == part['uuid']
    before = metadata()
    commands = []
    command = target.command
    def observe(*args):
        commands.append(args)
        return command(*args)
    target.command = observe
    target.apply_plan(PLAN)
    target.command = command
    assert not any(args[0] == 'sgdisk' for args in commands)
    assert metadata() == before and protected() == expected
    # A foreign change refuses before writing anything, even when our two
    # partitions already exist. Restore only our disposable fixture afterwards.
    run('sgdisk', '--change-name=1:foreign change', DISK)
    changed = metadata()
    try:
        target.apply_plan(PLAN)
        raise AssertionError('Accepted an unrelated partition change')
    except target.TargetError as error:
        assert 'existing partition changed' in str(error)
    assert metadata() == changed
    run('sgdisk', '--change-name=1:macOS fixture', DISK)
    corruption_checks = []
    for header in (4096, 24 * 1024**3 - 4096):
        with open(DISK, 'r+b', buffering=0) as handle:
            original = os.pread(handle.fileno(), 4096, header)
            corrupted = bytearray(original)
            corrupted[16] ^= 1
            os.pwrite(handle.fileno(), corrupted, header)
            os.fsync(handle.fileno())
            damaged = metadata()
            try:
                target.apply_plan(PLAN)
                raise AssertionError('Accepted a damaged GPT copy')
            except target.TargetError as error:
                assert 'GPT is damaged' in str(error)
            assert metadata() == damaged
            os.pwrite(handle.fileno(), original, header)
            os.fsync(handle.fileno())
            corruption_checks.append(header)
    assert protected() == expected
    final = target.read_table(DISK)
    run('umount', ROOT)
    return {'phase': 'resumed', 'partial_resume': True, 'idempotent': True,
            'protected': expected, 'foreign_change_refused_without_write': True,
            'damaged_gpt_refused_without_write': corruption_checks,
            'table': final, 'finished_at': time.time()}


if __name__ == '__main__':
    guard()
    action = {'initialize': initialize, 'interrupt': interrupt, 'resume': resume}[sys.argv[1]]
    result = action()
    RESULT.write_text(json.dumps(result, indent=2) + '\n')
    print(result['phase'], flush=True)
