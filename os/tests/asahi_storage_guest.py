#!/usr/bin/env python3
"""Private encrypted-copy acceptance on the owned Asahi target VM fixture."""
from contextlib import ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture = load('fixture', '/var/tmp/harness-target-guest.py')
storage = load('storage', '/var/tmp/storage.py')
PASSWORD = 'firstboot-local-42'
STATE = fixture.PLAN.with_name('storage.json')
INPUT = Path('/var/tmp/harness-storage-input.json')
EVIDENCE = Path('/var/tmp/harness-storage-evidence.json')
RESULT = Path('/var/tmp/harness-storage-result.json')
ENCRYPTED = '/dev/vdb6'


def payload():
    inputs = json.loads(INPUT.read_text())
    return storage.Payload('/dev/vdc', inputs['image_sha256'], inputs['source_commit'])


def guard():
    fixture.guard()
    storage.target.platform_esp = lambda: fixture.ESP
    serial = fixture.run('lsblk', '-ndo', 'SERIAL', '/dev/vdc')
    assert serial == 'HARNESS_PAYLOAD', repr(serial)
    assert fixture.run('blockdev', '--getro', '/dev/vdc') == '1'
    fixture.mount()


def header():
    metadata = json.loads(storage.run('cryptsetup', 'luksDump', '--dump-json-metadata', ENCRYPTED))
    offset = int(metadata['segments']['0']['offset'])
    with open(ENCRYPTED, 'rb', buffering=0) as handle:
        content = os.pread(handle.fileno(), offset, 0)
    return {'sha256': hashlib.sha256(content).hexdigest(), 'bytes': offset,
            'uuid': storage.run('cryptsetup', 'luksUUID', ENCRYPTED),
            'kdf': metadata['keyslots']['0']['kdf']['type']}


def secret_absent():
    for path in (STATE, fixture.PLAN):
        assert PASSWORD not in path.read_text()
    state = json.loads(STATE.read_text())
    assert all('pass' not in key and 'key' not in key for key in state)


def interrupt_encryption():
    command = storage.run
    def interrupted(*args, **kwargs):
        result = command(*args, **kwargs)
        if args[:2] == ('cryptsetup', 'luksFormat'):
            evidence = {'header': header(), 'phase_after_format': json.loads(STATE.read_text())['phase']}
            assert evidence['phase_after_format'] == 'planned'
            secret_absent()
            EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
            os._exit(76)
        return result
    storage.run = interrupted
    storage.install(fixture.PLAN, payload(), PASSWORD)
    raise AssertionError('The encryption interruption was not exercised')


def interrupt_copy():
    evidence = json.loads(EVIDENCE.read_text())
    assert header() == evidence['header']
    record = STATE.read_bytes()
    try:
        storage.install(fixture.PLAN, payload(), 'incorrect-password')
        raise AssertionError('The retry accepted an incorrect disk password')
    except storage.StorageError as error:
        assert 'cryptsetup failed' in str(error)
    assert STATE.read_bytes() == record and header() == evidence['header']
    assert not storage.probe('/dev/vdb5').get('TYPE')
    evidence['incorrect_password_rejected_before_formatting'] = True
    original = storage.run
    def stop_during_copy(*args, **kwargs):
        if args[0] != 'rsync':
            return original(*args, **kwargs)
        destination = Path(args[-1])
        with open('/var/tmp/interrupted-rsync.log', 'wb') as log:
            process = subprocess.Popen(list(map(str, args)), stdout=log, stderr=log)
            deadline = time.monotonic() + 60
            marker = destination / 'etc/passwd'
            while not marker.is_file():
                if process.poll() is not None or time.monotonic() >= deadline:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=15)
                    raise AssertionError('rsync did not reach a live partial copy')
                time.sleep(.02)
            assert process.poll() is None
            process.kill()
            assert process.wait(timeout=15) == -9
        state = json.loads(STATE.read_text())
        assert state['phase'] == 'copying'
        assert header() == evidence['header']
        evidence.update(partial_copy=True, partial_state=state, partial_passwd_sha256=fixture.digest(marker))
        EVIDENCE.write_text(json.dumps(evidence, indent=2) + '\n')
        secret_absent()
        os._exit(77)
    storage.run = stop_during_copy
    storage.install(fixture.PLAN, payload(), PASSWORD)
    raise AssertionError('The real rsync interruption was not exercised')


def assert_protected():
    baseline = json.loads(fixture.BASELINE.read_text())
    assert fixture.protected() == {k: v for k, v in baseline.items() if k not in ('table', 'started_at')}


def verify_copy(state):
    with payload().open() as source, storage.encrypted_root(ENCRYPTED, state, PASSWORD.encode()) as mapper:
        with storage.work_directory() as root, ExitStack() as mounts:
            top = mounts.enter_context(storage.mounted(mapper, root / 'top', 'ro,rescue=nologreplay,subvolid=5'))
            boot = mounts.enter_context(storage.mounted('/dev/vdb5', root / 'boot', 'ro,noload'))
            for src, dst, excludes in [(source.root, top / 'root', ['/boot/***', '/home/***']),
                                        (source.home, top / 'home', []), (source.boot, boot, ['/efi/***'])]:
                changes = storage.run('rsync', '-aHAXnci', '--numeric-ids', '--one-file-system', '--delete',
                                      *('--exclude=' + value for value in excludes), str(src) + '/', str(dst) + '/', timeout=180)
                assert not changes, changes
            image = json.loads((top / 'root/usr/share/harness-os/image.json').read_text())
            manifest = image['session_package']['files']
            for name, expected in manifest.items():
                assert fixture.digest(top / 'root' / name) == expected, name
            for name, expected in image['first_boot']['files'].items():
                assert fixture.digest(top / 'root' / name) == expected['sha256'], name
            return {'runtime_files_checked': len(manifest), 'source_commit': image['source_commit'],
                    'root_uuid': storage.probe(mapper)['UUID'], 'boot_uuid': storage.probe('/dev/vdb5')['UUID']}


def preserved_project(state, *, create=False):
    with storage.encrypted_root(ENCRYPTED, state, PASSWORD.encode()) as mapper, storage.work_directory() as root:
        with storage.mounted(mapper, root / 'home', 'subvol=home,noatime') as home:
            project = home / 'me/projects/keep/result.txt'
            if create:
                project.parent.mkdir(parents=True)
                project.write_text('Keep work after installation is copied.\n')
                storage.run('sync', '-f', home)
            return fixture.digest(project)


def finish():
    evidence = json.loads(EVIDENCE.read_text())
    assert json.loads(STATE.read_text())['phase'] == 'copying'
    assert header() == evidence['header']
    state = storage.install(fixture.PLAN, payload(), PASSWORD)
    assert state['phase'] == 'copied' and header() == evidence['header']
    evidence['copy_verification'] = verify_copy(state)
    assert evidence['copy_verification']['root_uuid'] == state['root_uuid']
    assert evidence['copy_verification']['boot_uuid'] == state['boot_uuid']
    assert_protected()
    project = preserved_project(state, create=True)
    record = STATE.read_bytes()
    commands = []
    command = storage.run
    def observed(*args, **kwargs):
        commands.append(args)
        return command(*args, **kwargs)
    storage.run = observed
    assert storage.install(fixture.PLAN, payload(), PASSWORD) == state
    storage.run = command
    assert not any(args[0] in ('rsync', 'mkfs.btrfs', 'mkfs.ext4') or args[:2] == ('cryptsetup', 'luksFormat') for args in commands)
    assert STATE.read_bytes() == record
    assert preserved_project(state) == project and header() == evidence['header']
    assert_protected()
    secret_absent()
    fixture.run('umount', fixture.ROOT)
    assert not Path('/dev/mapper/harness-stage-' + state['luks_uuid'].replace('-', '')).exists()
    evidence.update(status='passed', state=state, project_sha256=project,
                    completed_retry_preserves_work=True, protected_data_unchanged=True,
                    header_unchanged=True, no_secret_in_records=True, mapping_closed=True)
    RESULT.write_text(json.dumps(evidence, indent=2) + '\n')
    print('Fresh encrypted copy resumed; complete file comparison, runtime hashes and project preservation passed.', flush=True)


if __name__ == '__main__':
    guard()
    {'interrupt-encryption': interrupt_encryption, 'interrupt-copy': interrupt_copy, 'finish': finish}[sys.argv[1]]()
