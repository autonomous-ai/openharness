import json
from pathlib import Path
import tempfile
import unittest

from vm_artifacts import discard_passed_disks


class DiskCleanup(unittest.TestCase):
    def test_passing_receipt_keeps_evidence_and_removes_only_owned_disks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            disk = root / 'target.raw'
            disk.write_bytes(b'disk')
            log = root / 'serial.log'
            log.write_text('passed')
            receipt = {'status': 'passed', 'checks': ['encrypted reboot']}
            (root / 'receipt.json').write_text(json.dumps(receipt))
            discard_passed_disks(root, receipt, disk, disk)
            self.assertFalse(disk.exists())
            self.assertEqual(log.read_text(), 'passed')
            retained = json.loads((root / 'receipt.json').read_text())
            self.assertEqual(retained['status'], 'passed')
            self.assertEqual(retained['disk_cleanup']['removed'],
                             [{'path': 'target.raw', 'logical_bytes': 4}])

    def test_failed_test_retains_disk_for_diagnosis(self):
        with tempfile.TemporaryDirectory() as temp:
            disk = Path(temp) / 'target.raw'
            disk.write_bytes(b'disk')
            discard_passed_disks(temp, {'status': 'failed'}, disk)
            self.assertTrue(disk.exists())

    def test_external_fixture_or_symlink_refused_before_any_deletion(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / 'test'
            output.mkdir()
            source = root / 'input.raw'
            source.write_bytes(b'input')
            disk = output / 'target.raw'
            disk.write_bytes(b'test')
            link = output / 'link.raw'
            link.symlink_to(source)
            for forbidden in (source, link, output / 'serial.log'):
                with self.subTest(forbidden=forbidden):
                    receipt = {'status': 'passed'}
                    (output / 'receipt.json').write_text(json.dumps(receipt))
                    with self.assertRaises(ValueError):
                        discard_passed_disks(output, receipt, disk, forbidden)
                    self.assertTrue(disk.exists())
                    self.assertEqual(source.read_bytes(), b'input')
                    self.assertEqual(json.loads((output / 'receipt.json').read_text())['status'], 'failed')

    def test_unrecorded_success_does_not_remove_disk(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            disk = root / 'target.raw'
            disk.write_bytes(b'disk')
            with self.assertRaises(FileNotFoundError):
                discard_passed_disks(root, {'status': 'passed'}, disk)
            self.assertTrue(disk.exists())


if __name__ == '__main__':
    unittest.main()
