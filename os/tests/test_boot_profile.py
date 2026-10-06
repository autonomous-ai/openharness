import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('boot_profile', Path(__file__).parents[1] / 'boot_profile.py')
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class BootProfiles(unittest.TestCase):
    def test_t2_update_requires_platform_helpers_and_identical_kernel_pin(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            marker = root / 'etc/harness-platform.json'
            marker.parent.mkdir()
            marker.write_text(json.dumps({'schema': 1, 'id': 'apple-t2'}))
            pin = root / 'usr/share/harness-os/apple-t2/kernel.json'
            pin.parent.mkdir(parents=True)
            pin.write_text('{"kernel_release":"tested"}')
            package = root / 'package.tar.gz'
            def archive(version, helpers=True, kernel_helpers=False):
                with tarfile.open(package, 'w:gz') as output:
                    entries = {'usr/share/harness-os/apple-t2/kernel.json': json.dumps({'kernel_release': version}).encode()}
                    if helpers:
                        entries.update({'usr/lib/harness-os/' + name + '.py': b'fixture' for name in
                                        ['boot_profile', 't2_install', 't2_firmware', 'firmware_names']})
                    if kernel_helpers:
                        entries.update({'usr/lib/harness-os/' + name + '.py': b'fixture' for name in
                                        ['t2_update', 't2_kernel']})
                    for name, data in entries.items():
                        info = tarfile.TarInfo(name)
                        info.size = len(data)
                        output.addfile(info, io.BytesIO(data))
            archive('tested')
            boot.validate_update(package, root)
            archive('untested')
            with self.assertRaisesRegex(ValueError, 'different T2 kernel'):
                boot.validate_update(package, root)
            with self.assertRaisesRegex(ValueError, 'transaction helpers'):
                boot.validate_update(package, root, allow_kernel_change=True)
            archive('untested', kernel_helpers=True)
            self.assertEqual(boot.validate_update(package, root, allow_kernel_change=True), {'kernel_release': 'untested'})
            archive('untested')
            self.assertEqual(boot.validate_update(package, root, allow_kernel_change=True, kernel_rollback=True),
                             {'kernel_release': 'untested'})
            archive('tested', False)
            with self.assertRaisesRegex(ValueError, 'does not include the T2 platform'):
                boot.validate_update(package, root)

    def test_legacy_pc_and_t2_require_their_own_boot_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            self.assertEqual(boot.selected(root)['kernel'], 'linux-lts')
            marker = root / 'etc/harness-platform.json'
            marker.parent.mkdir()
            marker.write_text(json.dumps({'schema': 1, 'id': 'apple-t2'}))
            self.assertEqual(boot.selected(root)['kernel'], 'linux-t2')
            self.assertEqual(boot.boot_files('apple-t2'), {'vmlinuz-linux-t2', 'initramfs-linux-t2.img', 'grub/grub.cfg'})
            for value in [{'schema': True, 'id': 'pc'}, {'schema': 1, 'id': 'unknown'}, {}, []]:
                marker.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    boot.selected(root)
            marker.unlink()
            marker.symlink_to(root / 'missing')
            with self.assertRaises(ValueError):
                boot.selected(root)


if __name__ == '__main__':
    unittest.main()
