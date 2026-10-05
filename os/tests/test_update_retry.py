import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('public_update_retry', Path(__file__).with_name('update_retry.py'))
retry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retry)


class PublicRetryEvidence(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state = Path('var/lib/harness-os')
        self.probe = Path('usr/share/hn-os-update-probe/value')
        self.old = '20261005T000000Z-12345678'
        self.new = '20261005T000001Z-12345678'
        self.receipt_id = '20261005T000002Z-12345678'
        self.failed = {'snapshot': '2026/10/01', 'checkpoint': self.old, 'exit_status': 1}
        self.write(self.state / 'install.json', {'root_uuid': 'private-test-root'})
        self.write(self.state / 'update.json', dict(self.failed, exit_status=0))
        self.write(Path('.snapshots') / self.old / 'checkpoint.json',
                   {'root_uuid': 'private-test-root', 'reason': 'before-update'})
        self.write(Path('.snapshots') / self.new / 'checkpoint.json',
                   {'root_uuid': 'private-test-root', 'reason': 'before-harness-update'})
        self.write(self.state / 'runtime-updates/latest.json', {'id': self.receipt_id})
        self.runtime = self.state / 'runtime-updates' / self.receipt_id / 'receipt.json'
        self.write(self.runtime, {'status': 'applied', 'root_uuid': 'private-test-root', 'checkpoint': self.new})
        for path, data in [(self.probe, b'2\n'), (Path('.snapshots') / self.old / 'root' / self.probe, b'1\n')]:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_bytes(data)
        self.before = {'failed_update': self.failed, 'root_uuid': 'private-test-root', 'snapshots_before': 0,
                       'checkpoint_sha256': hashlib.sha256((self.root / '.snapshots' / self.old / 'checkpoint.json').read_bytes()).hexdigest()}

    def write(self, path, data):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data))

    def test_completed_public_retry_requires_both_package_versions_and_original_checkpoint(self):
        result = retry.verify(self.root, self.before)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['completed_update']['checkpoint'], self.old)
        self.assertEqual(result['runtime_update']['checkpoint'], self.new)

    def test_failed_or_replaced_retry_and_changed_installation_cannot_pass(self):
        for change in [{'exit_status': 1}, {'checkpoint': self.new}, {'snapshot': '2026/10/02'}]:
            self.write(self.state / 'update.json', dict(self.failed, exit_status=0) | change)
            with self.subTest(change=change), self.assertRaises(AssertionError):
                retry.verify(self.root, self.before)
        self.write(self.state / 'update.json', dict(self.failed, exit_status=0))
        self.write(self.state / 'install.json', {'root_uuid': 'another-root'})
        with self.assertRaisesRegex(AssertionError, 'identity changed'):
            retry.verify(self.root, self.before)

    def test_missing_upgrade_changed_recovery_point_or_duplicate_checkpoint_cannot_pass(self):
        paths = [(self.probe, b'1\n'), (Path('.snapshots') / self.old / 'root' / self.probe, b'2\n')]
        for path, bad in paths:
            original = (self.root / path).read_bytes()
            (self.root / path).write_bytes(bad)
            with self.subTest(path=str(path)), self.assertRaises(AssertionError):
                retry.verify(self.root, self.before)
            (self.root / path).write_bytes(original)
        (self.root / '.snapshots/duplicate').mkdir()
        with self.assertRaisesRegex(AssertionError, 'another Arch checkpoint'):
            retry.verify(self.root, self.before)

    def test_missing_harness_apply_or_tampered_checkpoint_identity_cannot_pass(self):
        original = retry.read(self.root / self.runtime)
        for change in [{'status': 'applying'}, {'checkpoint': self.old}, {'checkpoint': '../escape'}]:
            self.write(self.runtime, dict(original, **change))
            with self.subTest(change=change), self.assertRaises(AssertionError):
                retry.verify(self.root, self.before)
        self.write(self.runtime, original)
        for path in ['../escape', '/other-root']:
            before = copy.deepcopy(self.before)
            before['failed_update']['checkpoint'] = path
            with self.subTest(path=path), self.assertRaisesRegex(AssertionError, 'Unsafe checkpoint'):
                retry.verify(self.root, before)
        self.before['checkpoint_sha256'] = '0' * 64
        with self.assertRaises(AssertionError):
            retry.verify(self.root, self.before)


if __name__ == '__main__':
    unittest.main()
