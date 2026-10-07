"""State ownership and non-destructive retry checks for private Asahi storage."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_asahi_target import fixture, ESP
spec = importlib.util.spec_from_file_location('asahi_storage', Path(__file__).resolve().parents[1] / 'platforms/apple-silicon/storage.py')
storage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(storage)


class StorageState(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.path = self.root / 'storage.json'
        self.plan = storage.target.new_plan(fixture(), ESP)
        self.state = storage.new_state(self.plan, 'a' * 64, 'b' * 40)

    def read(self):
        return storage.read_state(self.path, self.plan, 'a' * 64, 'b' * 40)

    def test_new_installations_have_distinct_persisted_identities_and_no_password(self):
        another = storage.new_state(self.plan, 'a' * 64, 'b' * 40)
        self.assertTrue(set(self.state[name] for name in ('luks_uuid', 'root_uuid', 'boot_uuid')).isdisjoint(
            another[name] for name in ('luks_uuid', 'root_uuid', 'boot_uuid')))
        storage.save_state(self.path, self.state)
        self.assertEqual(self.read(), self.state)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('password', self.path.read_text())

    def test_record_binds_exact_target_and_payload(self):
        storage.save_state(self.path, self.state)
        cases = [(storage.target.new_plan(fixture(), ESP), 'a' * 64, 'b' * 40),
                 (self.plan, 'c' * 64, 'b' * 40), (self.plan, 'a' * 64, 'c' * 40)]
        before = self.path.read_bytes()
        for plan, digest, source in cases:
            with self.assertRaises(storage.StorageError):
                storage.read_state(self.path, plan, digest, source)
        self.assertEqual(self.path.read_bytes(), before)

    def test_corrupt_or_foreign_record_never_falls_back_to_fresh_format(self):
        storage.save_state(self.path, self.state)
        for content in ['{', json.dumps({**self.state, 'phase': 'unknown'}),
                        json.dumps({**self.state, 'schema': True}),
                        json.dumps({**self.state, 'boot_uuid': self.state['root_uuid']}),
                        json.dumps({**self.state, 'password': 'must-not-be-saved'})]:
            self.path.write_text(content)
            with self.subTest(content=content), self.assertRaises(ValueError):
                self.read()
        self.path.unlink()
        self.assertIsNone(self.read())

    def test_interrupted_record_replacement_preserves_previous_phase(self):
        storage.save_state(self.path, self.state)
        with patch.object(storage.os, 'fsync', side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                storage.advance(self.path, self.state, 'copying')
        self.assertEqual(self.read()['phase'], 'planned')
        self.assertEqual(self.state['phase'], 'planned')
        self.assertFalse(list(self.root.glob('.storage-*')))

    def test_completed_phase_cannot_be_downgraded(self):
        storage.save_state(self.path, self.state)
        storage.advance(self.path, self.state, 'copied')
        before = self.path.read_bytes()
        for phase in storage.PHASES:
            storage.advance(self.path, self.state, phase)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.read()['phase'], 'copied')

    def test_loose_parent_symlink_and_fifo_are_refused(self):
        storage.save_state(self.path, self.state)
        self.root.chmod(0o777)
        with self.assertRaises(storage.target.TargetError):
            self.read()
        self.root.chmod(0o700)
        original = self.root / 'original'
        self.path.rename(original)
        self.path.symlink_to(original)
        with self.assertRaises(OSError):
            self.read()
        self.path.unlink()
        os.mkfifo(self.path, 0o600)
        with self.assertRaises(storage.target.TargetError):
            self.read()

    def test_owned_existing_filesystem_is_not_reformatted(self):
        with patch.object(storage, 'probe', return_value={'TYPE': 'btrfs', 'UUID': self.state['root_uuid']}), patch.object(storage, 'run') as run:
            storage.ensure_filesystem('/device', 'btrfs', self.state['root_uuid'], self.state, 'mkfs.btrfs')
            run.assert_not_called()

    def test_foreign_or_disappeared_completed_filesystem_is_never_formatted(self):
        cases = [({'TYPE': 'ext4', 'UUID': self.state['root_uuid']}, 'planned'),
                 ({'TYPE': 'btrfs', 'UUID': self.state['boot_uuid']}, 'planned'),
                 ({'PTTYPE': 'gpt'}, 'planned'), ({}, 'filesystems'), ({}, 'copying'), ({}, 'copied')]
        for values, phase in cases:
            state = {**self.state, 'phase': phase}
            with self.subTest(values=values, phase=phase), patch.object(storage, 'probe', return_value=values), patch.object(storage, 'run') as run:
                with self.assertRaises(storage.StorageError):
                    storage.ensure_filesystem('/device', 'btrfs', self.state['root_uuid'], state, 'mkfs.btrfs')
                run.assert_not_called()

    def test_invalid_password_does_not_touch_payload_or_target(self):
        for password in ('', None, b'secret', 'line\nbreak', 'null\0byte'):
            with self.assertRaises(storage.StorageError):
                storage.install(self.root / 'target.json', None, password)

    def test_cleanup_never_recursively_removes_a_populated_mountpoint(self):
        area = self.root / 'work'
        area.mkdir()
        data = area / 'mount' / 'keep'
        data.parent.mkdir()
        data.write_text('Keep this installed file')
        with patch.object(storage.tempfile, 'mkdtemp', return_value=str(area)):
            with self.assertRaises(OSError):
                with storage.work_directory():
                    pass
        self.assertEqual(data.read_text(), 'Keep this installed file')

    def test_mountpoint_does_not_follow_an_existing_symlink(self):
        source = self.root / 'source'
        source.mkdir()
        destination = self.root / 'destination'
        destination.symlink_to(source)
        with self.assertRaises(storage.StorageError):
            storage.mountpoint(source, destination)


if __name__ == '__main__':
    unittest.main()
