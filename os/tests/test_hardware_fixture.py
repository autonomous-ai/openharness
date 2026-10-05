"""Keep candidate hardware evidence tied to the bytes actually exercised."""
import hashlib
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest

from hardware_install_guest import apply_candidate, assigned_devices, load
from hardware_install_vm import candidate_record


class HardwareCandidate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.candidate = self.root / 'hardware.py'
        self.candidate.write_text('CANDIDATE = True\n')
        for args in [('init', '-q'), ('add', 'hardware.py'),
                     ('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
                      'commit', '-qm', 'candidate')]:
            subprocess.run(['git', '-C', str(self.root), *args], check=True, capture_output=True, timeout=10)

    def test_committed_source_matches_staged_and_installed_bytes(self):
        record = candidate_record(self.candidate)
        self.assertEqual(record['source_commit'], subprocess.check_output(
            ['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip())
        self.assertEqual(record['path'], 'hardware.py')
        self.assertEqual(record['bytes'], len(self.candidate.read_bytes()))
        self.assertEqual(record['sha256'], hashlib.sha256(self.candidate.read_bytes()).hexdigest())
        live = self.root / 'live.py'
        installed = self.root / 'installed.py'
        for source, destination in [(self.candidate, live), (live, installed)]:
            self.assertEqual(apply_candidate(source, destination, record['sha256']), record['sha256'])
            self.assertEqual(destination.read_bytes(), self.candidate.read_bytes())
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)

    def test_dirty_or_symlinked_candidate_cannot_borrow_commit_identity(self):
        self.candidate.write_text('CANDIDATE = False\n')
        with self.assertRaisesRegex(ValueError, 'Commit the candidate'):
            candidate_record(self.candidate)
        link = self.root / 'linked.py'
        link.symlink_to(self.candidate)
        with self.assertRaisesRegex(ValueError, 'regular tracked'):
            candidate_record(link)

    def test_changed_transfer_is_rejected_before_replacing_destination(self):
        record = candidate_record(self.candidate)
        self.candidate.write_text('MODIFIED_AFTER_RECORD = True\n')
        destination = self.root / 'installed.py'
        destination.write_text('ORIGINAL = True\n')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            apply_candidate(self.candidate, destination, record['sha256'])
        self.assertEqual(destination.read_text(), 'ORIGINAL = True\n')


class NativeAssignmentFixture(unittest.TestCase):
    def test_exact_supported_radio_assignment_cases_use_private_sysfs(self):
        hardware = load('hardware_policy_fixture', Path(__file__).resolve().parents[1] / 'hardware.py')
        original_run = hardware.run
        with tempfile.TemporaryDirectory() as directory:
            devices = assigned_devices(hardware, Path(directory))
        self.assertEqual(len(devices), 3)
        self.assertEqual({d['id'] for d in devices}, {'14e4:43a0'})
        self.assertTrue(all(not hardware.needs_broadcom(d) for d in devices))
        self.assertIs(hardware.run, original_run)


if __name__ == '__main__':
    unittest.main()
