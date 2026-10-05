from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / 'desktop/scripts/web-release-mode.sh'


class WebReleaseModeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.repo = root / 'checkout'
        self.repo.mkdir()
        self.origin = root / 'origin.git'
        subprocess.run(['git', 'init', '--bare', str(self.origin)], check=True, capture_output=True)
        self.git('init')
        self.git('config', 'user.name', 'Release test')
        self.git('config', 'user.email', 'release@example.invalid')
        self.git('commit', '--allow-empty', '-m', 'Fixture')
        self.sha = self.git('rev-parse', 'HEAD').stdout.strip()
        self.ref = 'refs/tags/v1.3.27_web'
        self.git('remote', 'add', 'origin', str(self.origin))

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, check=True,
                              text=True, capture_output=True, timeout=10)

    def mode(self, expected=None):
        return subprocess.run(['bash', str(SCRIPT), self.ref, expected or self.sha],
                              cwd=self.repo, text=True, capture_output=True, timeout=15)

    def publish(self, message):
        if message is None:
            self.git('tag', 'v1.3.27_web')
        else:
            self.git('tag', '-a', 'v1.3.27_web', '-m', message)
        self.git('push', 'origin', self.ref)

    def test_recovers_website_mode_after_checkout_peels_tag(self):
        self.publish('Harness website\n\nWebsite-Only: true')
        self.git('update-ref', self.ref, self.sha)
        self.assertEqual(self.git('cat-file', '-t', self.ref).stdout.strip(), 'commit')
        result = self.mode()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'true')
        self.assertEqual(self.git('cat-file', '-t', self.ref).stdout.strip(), 'tag')

    def test_normal_annotated_release_builds_flutter(self):
        self.publish('Harness web 1.3.27')
        result = self.mode()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'false')

    def test_missing_annotation_stops_instead_of_building_flutter(self):
        self.publish(None)
        result = self.mode()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('must be annotated', result.stderr)

    def test_moved_tag_stops_before_publication(self):
        self.publish('Harness website\n\nWebsite-Only: true')
        result = self.mode('a' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('differs from', result.stderr)


if __name__ == '__main__':
    unittest.main()
