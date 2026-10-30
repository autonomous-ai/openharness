import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('baseline', Path(__file__).parents[1] / 'tools/runtime-baseline.py')
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


class RuntimeBaseline(unittest.TestCase):
    def test_only_ancestor_release_tags_constrain_updates_and_versions_sort_numerically(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), '-c', 'user.name=Fixture',
                                                '-c', 'user.email=fixture@example.test', *args],
                                               text=True, stderr=subprocess.DEVNULL).strip()
            git('init', '-b', 'main')
            git('commit', '--allow-empty', '-m', 'first')
            git('tag', 'v0.3.9_cli')
            git('commit', '--allow-empty', '-m', 'published')
            published = git('rev-parse', 'HEAD')
            git('tag', 'v0.3.57_cli')
            git('tag', 'v0.1.12_tui')
            git('tag', 'v900.0_cli')  # Not a release version.
            git('checkout', '-b', 'other')
            git('commit', '--allow-empty', '-m', 'not in the OS')
            git('tag', 'v1.0.0_cli')
            git('checkout', 'main')
            git('commit', '--allow-empty', '-m', 'unreleased OpenCode compatibility fix')
            self.assertEqual(baseline.baselines(root), {
                'cli': {'version': '0.3.57', 'commit': published},
                'hn': {'version': '0.1.12', 'commit': published},
            })
            # The CLI built for the OS calls itself the newest published one it contains.
            self.assertEqual(baseline.cli_version(root), '0.3.57')
            # An incomplete checkout must fail instead of silently allowing a downgrade.
            (root / '.git/shallow').write_text(git('rev-parse', 'HEAD') + '\n')
            with self.assertRaisesRegex(ValueError, 'full Git history'):
                baseline.baselines(root)

    def test_with_no_published_cli_the_development_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', '-C', str(root), 'init', '-b', 'main'], check=True, capture_output=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Fixture', '-c', 'user.email=f@example.test',
                            'commit', '--allow-empty', '-m', 'first'], check=True, capture_output=True)
            (root / 'cli').mkdir()
            (root / 'cli/package.json').write_text(json.dumps({'version': '0.0.1'}))
            self.assertEqual(baseline.cli_version(root), '0.0.1')
