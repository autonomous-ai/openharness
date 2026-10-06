"""The combined-update fixture must use a complete, compatible helper set."""
import importlib.util
import inspect
from pathlib import Path
import shutil
import tempfile
import unittest

from release_update_vm import relocate_boot_loader


class ReleaseUpdateFixture(unittest.TestCase):
    def test_relocation_loads_the_real_new_api_and_only_changes_its_dependency_path(self):
        source = Path(__file__).resolve().parents[1]
        original = (source / 'system.py').read_text()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copyfile(source / 'boot_profile.py', root / 'boot_profile.py')
            relocated = relocate_boot_loader(original, root)
            self.assertEqual(relocated.replace('Path(' + repr(str(root / 'boot_profile.py')) + ')',
                                               "Path(__file__).with_name('boot_profile.py')"), original)
            target = root / 'candidate-system.py'
            target.write_text(relocated)
            spec = importlib.util.spec_from_file_location('candidate_system_fixture', target)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            self.assertIn('noninteractive', inspect.signature(module.update).parameters)
            self.assertEqual(module.boot_module().selected(root)['id'], 'pc')
            self.assertEqual(Path(module.boot_module().__file__), root / 'boot_profile.py')
        with self.assertRaises(ValueError):
            relocate_boot_loader(original, 'relative')
        for changed in [original + original, original.replace("with_name('boot_profile.py')", "with_name('other.py')")]:
            with self.assertRaises(ValueError):
                relocate_boot_loader(changed, '/tmp/unused')


if __name__ == '__main__':
    unittest.main()
