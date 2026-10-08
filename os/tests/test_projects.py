import importlib.util
from datetime import datetime
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('projects', Path(__file__).resolve().parents[1] / 'projects.py')
projects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projects)


class Projects(unittest.TestCase):
    def test_existing_users_get_shared_account_discovery_without_replacing_instructions(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            root = home / 'projects'
            root.mkdir()
            (root / 'AGENTS.md').write_text('My instructions.\n')
            target = home / 'user-managed.md'
            target.write_text('Keep linked instructions.\n')
            (root / 'CLAUDE.md').symlink_to(target)
            projects.prepare(home)
            projects.prepare(home)
            self.assertEqual((root / 'AGENTS.md').read_text().count('<!-- harness-os-connections -->'), 1)
            self.assertTrue((root / 'AGENTS.md').read_text().startswith('My instructions.\n'))
            self.assertEqual(target.read_text(), 'Keep linked instructions.\n')
            self.assertTrue((root / 'CLAUDE.md').is_symlink())

    def test_agent_folders_match_cli_convention_and_never_reuse_work(self):
        with tempfile.TemporaryDirectory() as temp:
            now = datetime(2026, 10, 4, 9, 5, 7)
            folders = [projects.new_project('OpenCode', temp, now) for _ in range(3)]
            self.assertEqual([path.name for path in folders], ['opencode-2026-10-04-09-05',
                'opencode-2026-10-04-09-05-07', 'opencode-2026-10-04-09-05-07-2'])
            self.assertTrue(all(path.parent == Path(temp) / 'projects' and path.is_dir() for path in folders))

    def test_legacy_capitalization_keeps_old_session_paths_working(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            legacy = home / 'Projects'
            legacy.mkdir()
            (legacy / 'keep.txt').write_text('my work')
            if (home / 'projects').exists():
                self.skipTest('Case-sensitive migration needs a Linux filesystem')
            root = projects.prepare(home)
            self.assertEqual((root / 'keep.txt').read_text(), 'my work')
            self.assertTrue(legacy.is_symlink())
            self.assertEqual((legacy / 'keep.txt').read_text(), 'my work')
            self.assertEqual(projects.prepare(home), root)

    def test_two_existing_directories_are_not_merged_or_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            root = projects.prepare(home)
            if (home / 'Projects').exists():
                self.skipTest('Case-sensitive migration needs a Linux filesystem')
            (root / 'same.txt').write_text('new work')
            (home / 'Projects').mkdir()
            (home / 'Projects/same.txt').write_text('old work')
            projects.prepare(home)
            self.assertEqual((root / 'same.txt').read_text(), 'new work')
            self.assertEqual((home / 'Projects/same.txt').read_text(), 'old work')
