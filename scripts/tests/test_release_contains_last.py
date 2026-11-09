"""Run the four real release commands against a private Git fixture: none may release older code by accident.

A checkout nobody updated is still on origin/main, so "HEAD is on origin/main" let it through. v0.3.82_cli was
tagged that way on October 12, 2026, 27 minutes after v0.3.81_cli and three commits behind it.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

# kind -> (script, the version its last release has here, the version a dry run would cut next)
RELEASES = {
    'cli': ('cli/scripts/release-cli.sh', '0.3.81', '0.3.82'),
    'desktop': ('desktop/scripts/release-desktop.sh', '1.2.65', '1.2.66'),
    'backend': ('backend/scripts/release-be.sh', '1.2.63', '1.2.64'),
    'web': ('desktop/scripts/release-web.sh', '1.3.44', '1.3.45'),
}


class ReleaseContainsLastTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.remote = self.root / 'origin'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.manifest = self.root / 'manifest.json'
        self.env = dict(os.environ, PATH=str(self.bin) + os.pathsep + os.environ['PATH'], RELEASE_FIXTURE_MANIFEST=str(self.manifest))
        for name in ('BRANCH', 'GIT_DIR', 'GIT_WORK_TREE', 'META_URL', 'METADATA_PATH', 'GCS_BUCKET', 'GCS_PUBLIC_BASE_URL', 'OTA_KEY',
                     'VERSION_FLOOR', 'WORKFLOW'):
            self.env.pop(name, None)
        self.git('init', '-q', '-b', 'main')
        for script, _, _ in RELEASES.values():
            target = self.repo / script
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / script, target)
        self.git('add', '.')
        self.git('commit', '-qm', 'older')
        self.older = self.git('rev-parse', 'HEAD')
        self.git('commit', '--allow-empty', '-qm', 'newer')
        self.newer = self.git('rev-parse', 'HEAD')
        self.git('init', '-q', '--bare', str(self.remote))
        self.git('remote', 'add', 'origin', str(self.remote))
        self.git('push', '-q', 'origin', 'main')
        # The live manifest, and a signed-in gh that names the repository: all a dry run asks of either.
        for name, body in {
            'curl': '#!/usr/bin/env python3\nimport os\nprint(open(os.environ["RELEASE_FIXTURE_MANIFEST"]).read())\n',
            'gh': '#!/usr/bin/env python3\nimport sys\nif sys.argv[1:3] == ["repo", "view"]: print("fixture/repo")\n',
        }.items():
            path = self.bin / name
            path.write_text(body)
            path.chmod(0o755)
        self.live(cli='0.3.81', desktop='1.2.65')

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', *args],
                                       cwd=self.repo, env=self.env, stderr=subprocess.STDOUT, text=True, timeout=30).strip()

    def live(self, cli, desktop):
        self.manifest.write_text(json.dumps({'cli': {'version': cli}, 'desktop-macos': {'version': desktop}}))

    def tag(self, kind, version, commit):
        self.git('tag', '-a', f'v{version}_{kind}', '-m', f'{kind} {version}', commit)
        self.git('push', '-q', 'origin', f'v{version}_{kind}')

    def stale(self):
        """This checkout's main as it was before the newer commit: on origin/main, and behind it."""
        self.git('reset', '-q', '--hard', self.older)

    def release(self, kind, *args):
        return subprocess.run(['bash', RELEASES[kind][0], *args], cwd=self.repo, env=self.env, capture_output=True, text=True, timeout=30)

    def test_a_checkout_behind_the_last_release_is_refused(self):
        for kind, (_, last, _) in RELEASES.items():
            with self.subTest(kind=kind):
                self.tag(kind, last, self.newer)
                self.stale()
                before = self.git('ls-remote', '--tags', 'origin')
                for args in (['--dry-run'], []):
                    result = self.release(kind, *args)
                    self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertIn(f'does not contain v{last}_{kind}', result.stderr)
                    self.assertIn('1 commit(s)', result.stderr)
                    self.assertIn('--allow-older', result.stderr)
                self.assertEqual(self.git('ls-remote', '--tags', 'origin'), before)
                self.assertEqual(self.git('tag', '-l', f'v*_{kind}'), f'v{last}_{kind}')
                self.git('reset', '-q', '--hard', self.newer)

    def test_a_rollback_is_allowed_by_name(self):
        for kind, (_, last, following) in RELEASES.items():
            with self.subTest(kind=kind):
                self.tag(kind, last, self.newer)
                self.stale()
                result = self.release(kind, '--allow-older', '--dry-run')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f'does not contain v{last}_{kind}', result.stdout + result.stderr)
                self.assertIn(following, result.stdout)
                self.git('reset', '-q', '--hard', self.newer)

    def test_a_checkout_that_contains_the_last_release_releases(self):
        for kind, (_, last, following) in RELEASES.items():
            with self.subTest(kind=kind, at='the tip'):
                self.tag(kind, last, self.older)
                result = self.release(kind, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(following, result.stdout)
            # Behind origin/main and at the last release: a release of less than everything is still one.
            with self.subTest(kind=kind, at='the last release'):
                self.stale()
                result = self.release(kind, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.git('reset', '-q', '--hard', self.newer)

    def test_the_version_being_served_counts_when_a_higher_tag_never_published(self):
        # October 12, 2026 as it stood: 0.3.82 tagged on the older commit and cancelled, 0.3.81 live from the newer.
        for kind, live, cancelled in (('cli', '0.3.81', '0.3.82'), ('desktop', '1.2.65', '1.2.66')):
            with self.subTest(kind=kind):
                self.tag(kind, live, self.newer)
                self.tag(kind, cancelled, self.older)
                self.stale()
                result = self.release(kind, '--dry-run')
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f'does not contain v{live}_{kind}', result.stderr)
                self.git('reset', '-q', '--hard', self.newer)
                result = self.release(kind, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_a_backend_patch_stays_within_1_to_99(self):
        # v1.2.100_backend was cut on October 21, 2026: the backend lacked the rollover Desktop already had.
        for last, args, following in (('1.2.99', [], '1.3.1'), ('1.2.100', [], '1.3.1'), ('1.2.5', ['minor'], '1.3.1'),
                                      ('1.2.5', ['major'], '2.0.1')):
            with self.subTest(last=last, args=args):
                self.tag('backend', last, self.newer)
                result = self.release('backend', *args, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(f'new tag : v{following}_backend', result.stdout)
                self.git('tag', '-d', f'v{last}_backend')
                self.git('push', '-q', 'origin', f':refs/tags/v{last}_backend')
        for exact in ('1.4.0', '1.4.100'):
            with self.subTest(exact=exact):
                result = self.release('backend', exact, '--dry-run')
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('1 to 99', result.stderr)

    def test_a_first_release_has_nothing_to_contain(self):
        self.live(cli='0.0.0', desktop='0.0.0')
        for kind in RELEASES:
            with self.subTest(kind=kind):
                result = self.release(kind, '--dry-run')
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()
