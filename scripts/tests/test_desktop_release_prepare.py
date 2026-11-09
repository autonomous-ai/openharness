"""Run the real prepare command against a private Git fixture and fake transport."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DesktopPrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.remote = self.root / 'origin'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.log = self.root / 'gh.json'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'], PREPARE_FIXTURE_LOG=str(self.log))
        self.env.pop('BRANCH', None)
        self.env.pop('GIT_DIR', None)
        self.env.pop('GIT_WORK_TREE', None)
        self.git('init', '-q', '-b', 'main')
        source = self.repo / 'desktop/scripts'
        source.mkdir(parents=True)
        shutil.copyfile(ROOT / 'desktop/scripts/release-desktop.sh', source / 'release-desktop.sh')
        self.git('add', '.')
        self.git('commit', '-qm', 'previous version')
        self.git('tag', '-a', 'v1.2.54_desktop', '-m', 'previous release')
        self.git('init', '-q', '--bare', str(self.remote))
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', '-q', 'origin', 'main', '--tags')
        self.git('switch', '-qc', 'candidate-branch')
        self.git('commit', '--allow-empty', '-qm', 'tested change')
        self.git('push', '-qu', 'origin', 'candidate-branch')
        for name, body in {
            'curl': '#!/usr/bin/env python3\nprint(\'{"desktop-macos":{"version":"1.2.54"}}\')\n',
            'gh': '#!/usr/bin/env python3\nimport json, os, sys\nfrom pathlib import Path\nPath(os.environ["PREPARE_FIXTURE_LOG"]).write_text(json.dumps(sys.argv[1:]))\n',
        }.items():
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', *args],
                                       cwd=self.repo, env=self.env, stderr=subprocess.STDOUT, text=True, timeout=10).strip()

    def run_script(self, *args):
        return subprocess.run(['bash', 'desktop/scripts/release-desktop.sh', *args], cwd=self.repo,
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_prepare_dispatches_pushed_pr_version_without_tagging_or_releasing(self):
        before = self.git('ls-remote', '--tags', 'origin')
        result = self.run_script('--prepare')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(self.log.read_text()), ['workflow', 'run', 'release-desktop.yml', '--ref', 'candidate-branch',
                                                          '-f', 'version=1.2.55', '-f', 'prepare_only=true'])
        self.assertEqual(self.git('ls-remote', '--tags', 'origin'), before)
        self.assertNotIn('v1.2.55_desktop', self.git('tag', '-l'))

    def test_prepare_dry_run_has_no_dispatch_or_tag(self):
        result = self.run_script('--prepare', '--dry-run', '1.3.1')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.log.exists())
        self.assertNotIn('v1.3.1_desktop', self.git('tag', '-l'))

    def test_prepare_rejects_dirty_or_unpushed_source_and_older_branch_tip(self):
        (self.repo / 'dirty').write_text('uncommitted')
        result = self.run_script('--prepare')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('dirty', result.stderr)
        (self.repo / 'dirty').unlink()
        self.git('commit', '--allow-empty', '-qm', 'not pushed')
        result = self.run_script('--prepare')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('not on origin/', result.stderr)
        self.git('reset', '--hard', 'HEAD~2')
        result = self.run_script('--prepare')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('pushed branch tip', result.stderr)
        self.assertFalse(self.log.exists())

    def test_prepare_and_wait_are_not_ambiguous(self):
        result = self.run_script('--prepare', '--wait')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('use --wait when releasing', result.stderr)
        self.assertFalse(self.log.exists())


if __name__ == '__main__':
    unittest.main()
