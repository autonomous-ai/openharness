import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('trial_projects', Path(__file__).resolve().parents[1] / 'trial_projects.py')
trial = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trial)


class TrialProjects(unittest.TestCase):
    def test_saved_project_tree_keeps_git_binary_data_permissions_and_links(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, target = base / 'projects', base / 'installed'
            (source / 'game/.git').mkdir(parents=True)
            (source / 'empty').mkdir()
            script = source / 'game/run'
            script.write_bytes(b'#!/bin/sh\nexit 0\n')
            script.chmod(0o751)
            (source / 'game/.git/HEAD').write_text('ref: refs/heads/main\n')
            (source / 'game/asset').write_bytes(bytes(range(256)) * 16)
            (source / 'current').symlink_to('game')
            (source / 'missing').symlink_to('future')
            (base / 'credentials').write_text('never copy this home file')
            receipt = trial.transfer(source, target)
            self.assertEqual((target / 'game/asset').read_bytes(), (source / 'game/asset').read_bytes())
            self.assertEqual((target / 'game/.git/HEAD').read_text(), 'ref: refs/heads/main\n')
            self.assertEqual((target / 'game/run').stat().st_mode & 0o777, 0o751)
            self.assertEqual((target / 'game/run').stat().st_mtime_ns, script.stat().st_mtime_ns)
            self.assertEqual(os.readlink(target / 'current'), 'game')
            self.assertEqual(os.readlink(target / 'missing'), 'future')
            self.assertTrue((target / 'empty').is_dir())
            self.assertFalse((target / 'credentials').exists())
            self.assertEqual(receipt['bytes'], trial.size(source))
            self.assertEqual(receipt['entries']['game/asset']['sha256'], hashlib.sha256((source / 'game/asset').read_bytes()).hexdigest())

    def test_external_links_are_preserved_without_copying_their_contents(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source, outside = base / 'projects', base / 'outside'
            source.mkdir()
            outside.mkdir()
            (outside / 'secret').write_text('outside project')
            (source / 'external').symlink_to(outside, target_is_directory=True)
            receipt = trial.transfer(source, base / 'installed')
            self.assertEqual(receipt['entries'], {'external': {'link': str(outside)}})
            self.assertEqual(receipt['bytes'], 0)
            with self.assertRaisesRegex(ValueError, 'ordinary directory'):
                trial.size(source / 'external')

    def test_special_files_fail_preflight_and_copy_without_hanging(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'projects'
            source.mkdir()
            os.mkfifo(source / 'pipe')
            with self.assertRaisesRegex(ValueError, 'special file'):
                trial.size(source)
            with self.assertRaisesRegex(ValueError, 'Close the service'):
                trial.transfer(source, Path(temp) / 'installed')

    def test_unreadable_directory_is_an_error_not_silent_data_loss(self):
        error = PermissionError('private directory')
        with self.assertRaises(PermissionError):
            trial.walk_error(error)


if __name__ == '__main__':
    unittest.main()
