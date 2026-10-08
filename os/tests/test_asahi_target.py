"""Asahi target ownership, reserved-space boundaries and resumable plan checks."""
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'platforms/apple-silicon/target.py'
spec = importlib.util.spec_from_file_location('asahi_target', SOURCE)
target = importlib.util.module_from_spec(spec)
spec.loader.exec_module(target)
GiB = 1024**3 // 4096
MiB = 1024**2 // 4096
ESP = 'e51d26b0-4c8f-41fb-9d83-a0fdd62327c0'
APFS = '7c3457ef-0000-11aa-aa11-00306543ecac'


def fixture():
    return {'partitiontable': {'label': 'gpt', 'id': '892dba11-cce3-4b97-a3ad-fca93c1340c6',
        'device': '/dev/nvme0n1', 'unit': 'sectors', 'firstlba': 6, 'lastlba': 64 * GiB - 6,
        'sectorsize': 4096, 'partitions': [
            {'node': '/dev/nvme0n1p1', 'start': MiB, 'size': GiB, 'type': APFS,
             'uuid': '0be7972c-66e7-47e6-a8aa-8043a0803c0f', 'name': 'macOS', 'attrs': 'RequiredPartition'},
            {'node': '/dev/nvme0n1p4', 'start': 4 * GiB, 'size': GiB // 2, 'type': target.EFI,
             'uuid': ESP, 'name': 'Asahi'},
            {'node': '/dev/nvme0n1p3', 'start': 20 * GiB, 'size': GiB, 'type': APFS,
             'uuid': '7d63c94a-e92c-4c66-ab52-cc620c9a917d', 'name': 'Recovery'},
        ]}}


def partial(plan, count):
    snapshot = fixture()
    snapshot['partitiontable']['partitions'] += copy.deepcopy(plan['additions'][:count])
    return snapshot


class TargetGeometry(unittest.TestCase):
    def test_only_uses_gap_after_its_esp_not_largest_gap(self):
        snapshot = fixture()
        before = copy.deepcopy(snapshot)
        plan = target.new_plan(snapshot, ESP.upper())
        boot, root = plan['additions']
        self.assertEqual(boot['start'], int(4.5 * GiB))
        self.assertEqual(boot['size'], GiB)
        self.assertEqual(root['start'], int(5.5 * GiB))
        self.assertEqual(root['start'] + root['size'], 20 * GiB)
        self.assertEqual([boot['node'], root['node']], ['/dev/nvme0n1p2', '/dev/nvme0n1p5'])
        self.assertEqual(snapshot, before)
        self.assertEqual(target.validate_plan(plan), plan)

    def test_alignment_stays_inside_gap_and_honors_minimum(self):
        snapshot = fixture()
        snapshot['partitiontable']['partitions'][1]['size'] += 1
        plan = target.new_plan(snapshot, ESP)
        self.assertEqual(plan['additions'][0]['start'], int(4.5 * GiB) + MiB)
        snapshot['partitiontable']['partitions'][2]['start'] = int(17.5 * GiB)
        with self.assertRaisesRegex(target.TargetError, '13 GiB'):
            target.new_plan(snapshot, ESP)

    def test_last_partition_uses_only_aligned_usable_sectors(self):
        snapshot = fixture()
        del snapshot['partitiontable']['partitions'][2]
        root = target.new_plan(snapshot, ESP)['additions'][1]
        self.assertEqual(root['start'] + root['size'], 64 * GiB - MiB)

    def test_refuses_invalid_ownership_geometry_and_identities(self):
        changes = [lambda t: t.update(label='dos'), lambda t: t.update(sectorsize=512),
                   lambda t: t.update(device='/dev/disk/by-id/unknown'), lambda t: t.update(lastlba=1),
                   lambda t: t['partitions'][1].update(type=APFS),
                   lambda t: t['partitions'][1].update(size=True),
                   lambda t: t['partitions'][1].update(size=-1),
                   lambda t: t['partitions'][1].update(start=MiB),
                   lambda t: t['partitions'][1].update(size=90 * GiB),
                   lambda t: t['partitions'][1].update(node='/dev/nvme1n1p4'),
                   lambda t: t['partitions'][1].update(node=None),
                   lambda t: t['partitions'][1].update(uuid=t['partitions'][0]['uuid']),
                   lambda t: t['partitions'][1].update(uuid='not-a-uuid'),
                   lambda t: t.update(partitions=None), lambda t: t.update(partitions=[None])]
        for change in changes:
            snapshot = fixture()
            change(snapshot['partitiontable'])
            with self.subTest(snapshot=snapshot), self.assertRaises(target.TargetError):
                target.new_plan(snapshot, ESP)
        with self.assertRaises(target.TargetError):
            target.new_plan(fixture(), '892dba11-cce3-4b97-a3ad-fca93c1340c6')
        for identities in ([], [ESP, ESP], [ESP], [ESP, '892dba11-cce3-4b97-a3ad-fca93c1340c6']):
            with self.subTest(identities=identities), self.assertRaises(target.TargetError):
                target.new_plan(fixture(), ESP, partition_ids=identities)

    def test_exact_partial_and_complete_resume(self):
        plan = target.new_plan(fixture(), ESP)
        for count in range(3):
            self.assertEqual(target.remaining(plan, partial(plan, count)), plan['additions'][count:])

    def test_changed_existing_or_new_partition_or_disk_refused(self):
        plan = target.new_plan(fixture(), ESP)
        changes = [lambda t: t.update(id='e106a700-879a-470f-8439-85a390a199ec'),
                   lambda t: t.update(lastlba=t['lastlba'] - 1),
                   lambda t: t['partitions'][0].update(name='Changed'),
                   lambda t: t['partitions'][0].update(attrs=''),
                   lambda t: t['partitions'].pop(0),
                   lambda t: t['partitions'][-1].update(size=10),
                   lambda t: t['partitions'][-1].update(type=APFS)]
        for change in changes:
            snapshot = partial(plan, 1)
            change(snapshot['partitiontable'])
            with self.subTest(snapshot=snapshot), self.assertRaises(target.TargetError):
                target.remaining(plan, snapshot)
        snapshot = partial(plan, 0)
        foreign = copy.deepcopy(snapshot['partitiontable']['partitions'][0])
        foreign.update(node='/dev/nvme0n1p8', start=30 * GiB, uuid='49579266-b21d-477f-9ff2-319c173a7096')
        snapshot['partitiontable']['partitions'].append(foreign)
        with self.assertRaisesRegex(target.TargetError, 'Another partition'):
            target.remaining(plan, snapshot)

    def test_plan_cannot_move_its_writes_into_macos(self):
        plan = target.new_plan(fixture(), ESP)
        plan['additions'][0]['start'] = MiB
        with self.assertRaises(target.TargetError):
            target.validate_plan(plan)

    def test_disk_discovery_ignores_usb_and_readonly_and_rejects_duplicate(self):
        disk = {'type': 'disk', 'name': '/dev/nvme0n1', 'ro': False, 'rm': False,
                'children': [{'type': 'part', 'partuuid': ESP.upper()}]}
        self.assertEqual(target.owning_disk({'blockdevices': [disk]}, ESP), '/dev/nvme0n1')
        for field in ['ro', 'rm']:
            changed = copy.deepcopy(disk)
            changed[field] = True
            with self.assertRaises(target.TargetError):
                target.owning_disk({'blockdevices': [changed]}, ESP)
        with self.assertRaises(target.TargetError):
            target.owning_disk({'blockdevices': [disk, disk]}, ESP)

    def test_platform_requires_asahi_16k_and_valid_terminated_uuid(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'chosen'
            path.write_bytes(ESP.upper().encode() + b'\0')
            with patch.object(target.platform, 'machine', return_value='aarch64'), patch.object(target.os, 'sysconf', return_value=16384):
                self.assertEqual(target.platform_esp(path), ESP)
                for value in [ESP.encode(), ESP.encode() + b'\n', b'x' * 36 + b'\0', b'\xff' * 36 + b'\0']:
                    path.write_bytes(value)
                    with self.assertRaises(target.TargetError):
                        target.platform_esp(path)
            with patch.object(target.platform, 'machine', return_value='x86_64'):
                with self.assertRaises(target.TargetError):
                    target.platform_esp(path)


class DurablePlan(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'target.json'
        self.plan = target.new_plan(fixture(), ESP)

    def test_roundtrip_never_overwrites_existing_plan(self):
        target.save_plan(self.path, self.plan)
        before = self.path.read_bytes()
        self.assertEqual(target.load_plan(self.path), self.plan)
        with self.assertRaises(FileExistsError):
            target.save_plan(self.path, target.new_plan(fixture(), ESP))
        self.assertEqual(self.path.read_bytes(), before)

    def test_interruption_before_rename_does_not_leave_a_partial_plan(self):
        with patch.object(target.os, 'fsync', side_effect=OSError('simulated power interruption')):
            with self.assertRaises(OSError):
                target.save_plan(self.path, self.plan)
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.root.glob('.target.json-*')), [])
        target.save_plan(self.path, self.plan)
        self.assertEqual(target.load_plan(self.path), self.plan)

    def test_interruption_after_rename_leaves_a_complete_resumable_record(self):
        sync = os.fsync
        calls = []
        def interrupted(fd):
            calls.append(fd)
            if len(calls) == 2:
                raise OSError('directory sync interrupted')
            sync(fd)
        with patch.object(target.os, 'fsync', side_effect=interrupted):
            with self.assertRaises(OSError):
                target.save_plan(self.path, self.plan)
        self.assertEqual(target.load_plan(self.path), self.plan)

    def test_filesystem_flush_failure_is_reported(self):
        with patch.object(target.platform, 'system', return_value='Linux'), \
                patch.object(target.ctypes, 'CDLL') as library, \
                patch.object(target.ctypes, 'get_errno', return_value=5):
            library.return_value.syncfs.return_value = -1
            with self.assertRaises(OSError) as failure:
                target.save_plan(self.path, self.plan)
            self.assertEqual(failure.exception.errno, 5)
        # Keep the published identity for a safe retry even if its flush failed.
        self.assertEqual(target.load_plan(self.path), self.plan)

    def test_private_directory_and_exclusive_writer_required(self):
        self.root.chmod(0o755)
        with self.assertRaises(target.TargetError):
            target.save_plan(self.path, self.plan)
        self.root.chmod(0o700)
        lock = self.root / 'target.json.lock'
        lock.touch(mode=0o600)
        with lock.open('r+b') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                target.save_plan(self.path, self.plan)
        self.assertFalse(self.path.exists())

    def test_busy_disk_lock_is_bounded_and_succeeds_after_release(self):
        lock = self.root / 'device-lock-fixture'
        lock.touch(mode=0o600)
        with lock.open('rb') as first, lock.open('rb') as second:
            fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(target.TargetError, 'disk is busy'):
                target.lock_disk(second.fileno(), timeout=0)
            fcntl.flock(first, fcntl.LOCK_UN)
            target.lock_disk(second.fileno(), timeout=0)

    def test_symlinks_hardlinks_loose_permissions_and_fifo_refused(self):
        target.save_plan(self.path, self.plan)
        link = self.root / 'link'
        link.symlink_to(self.path)
        with self.assertRaises(OSError):
            target.load_plan(link)
        link.unlink()
        os.link(self.path, link)
        with self.assertRaises(target.TargetError):
            target.load_plan(self.path)
        link.unlink()
        self.path.chmod(0o644)
        with self.assertRaises(target.TargetError):
            target.load_plan(self.path)
        os.mkfifo(self.root / 'fifo', 0o600)
        with self.assertRaises(target.TargetError):
            target.load_plan(self.root / 'fifo')

    def test_truncated_oversized_and_mutated_records_refused(self):
        target.save_plan(self.path, self.plan)
        for content in ['{', ' ' * (128 * 1024 + 1), json.dumps({**self.plan, 'schema': 2})]:
            self.path.write_text(content)
            with self.subTest(content=content[:80]), self.assertRaises(target.TargetError):
                target.load_plan(self.path)


if __name__ == '__main__':
    unittest.main()
