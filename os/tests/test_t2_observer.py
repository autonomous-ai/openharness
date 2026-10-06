"""Keep serial metadata and observer-only changes out of T2 image identity."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from t2_install_vm import guest_result, image_source_binding


class T2Observer(unittest.TestCase):
    def test_result_ignores_shell_metadata_but_not_changed_data(self):
        value = {'sha256': 'a' * 64}
        output = '\x1b]3008;start=first\x1b\\T2_RESULT=' + json.dumps(value) + '\r\n'
        self.assertEqual(guest_result(output), guest_result(output.replace('start=first', 'start=second')))
        self.assertNotEqual(guest_result(output), guest_result(output.replace('a' * 64, 'b' * 64)))
        for invalid in ['', output + output, 'T2_RESULT={bad json}\n']:
            with self.subTest(output=invalid), self.assertRaises(ValueError):
                guest_result(invalid)

    def test_reuse_requires_identical_build_inputs_and_image_workflow(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def git(*args):
                return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE).strip()
            git('init', '-b', 'main')
            git('config', 'user.name', 'Harness Test')
            git('config', 'user.email', 'test@localhost')
            files = {'os/installer.py': 'original', 'tui/source': 'original',
                     'os/tests/observer.py': 'original',
                     '.github/workflows/os-t2.yml': 'jobs:\n  image: original\n  machine: original\n'}
            for name, content in files.items():
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            git('add', '.')
            git('commit', '-m', 'Original image')
            baseline = git('rev-parse', 'HEAD')
            (root / 'os/tests/observer.py').write_text('corrected observer')
            (root / '.github/workflows/os-t2.yml').write_text('jobs:\n  image: original\n  machine: corrected\n')
            git('commit', '-am', 'Observer only')
            observer = git('rev-parse', 'HEAD')
            self.assertTrue(image_source_binding(root, baseline, observer)['build_inputs_identical'])
            for name in ['os/installer.py', 'tui/source', '.github/workflows/os-t2.yml']:
                with self.subTest(path=name):
                    git('reset', '--hard', observer)
                    (root / name).write_text('different build input')
                    git('commit', '-am', 'Changed input')
                    with self.assertRaisesRegex(ValueError, 'build a new T2 image'):
                        image_source_binding(root, baseline, git('rev-parse', 'HEAD'))
            git('reset', '--hard', observer)
            git('mv', 'os/installer.py', 'os/tests/moved-installer.py')
            git('commit', '-m', 'Move production input into test directory')
            with self.assertRaisesRegex(ValueError, 'build a new T2 image'):
                image_source_binding(root, baseline, git('rev-parse', 'HEAD'))


if __name__ == '__main__':
    unittest.main()
