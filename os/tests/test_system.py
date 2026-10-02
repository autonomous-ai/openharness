import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('hn_system', Path(__file__).parents[1] / 'system.py')
system = importlib.util.module_from_spec(spec)
spec.loader.exec_module(system)


class RecoveryGuards(unittest.TestCase):
    def test_recovery_rejects_wrong_filesystem_unsafe_boot_id_and_incomplete_checkpoint(self):
        good = {'root_uuid': 'root-identity', 'boot_uuid': 'ABCD-1234',
                'boot_sha256': {name: 'digest' for name in ['vmlinuz-linux-lts', 'initramfs-linux-lts.img', 'grub/grub.cfg']}}
        system.validate_checkpoint(good, 'root-identity')
        for bad in [dict(good, root_uuid='another-root'), dict(good, boot_uuid='../../sda1'), dict(good, boot_sha256={})]:
            with self.assertRaises(ValueError):
                system.validate_checkpoint(bad, 'root-identity')

    def test_snapshot_is_a_complete_real_date(self):
        self.assertEqual(system.snapshot_date('2026/10/01'), '2026/10/01')
        for date in ['2026/2/1', '2026/02/30', '2099/01/01', '../2026/01/01']:
            with self.assertRaises(Exception):
                system.snapshot_date(date)

    def test_checkpoint_cannot_escape_its_directory(self):
        self.assertEqual(system.checkpoint_name('20261002T000000Z-12345678'), '20261002T000000Z-12345678')
        for name in ['../@home', '/etc', '.', '', '-flag', 'a/b', 'a\n']:
            with self.assertRaises(ValueError):
                system.checkpoint_name(name)

    def test_boot_verification_detects_changed_added_and_removed_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            kernel = root / 'vmlinuz-linux-lts'
            kernel.write_bytes(b'kernel-one')
            before = system.boot_hashes(root)
            kernel.write_bytes(b'kernel-two')
            self.assertNotEqual(before, system.boot_hashes(root))
            kernel.write_bytes(b'kernel-one')
            (root / 'initramfs-linux-lts.img').write_bytes(b'initramfs')
            self.assertNotEqual(before, system.boot_hashes(root))
            kernel.unlink()
            self.assertNotEqual(before, system.boot_hashes(root))

    def test_update_preserves_custom_configuration_and_advances_both_repositories(self):
        config = ('[options]\nSigLevel = Required DatabaseOptional\nParallelDownloads = 5\n' +
                  ''.join(f'[{repo}]\nServer = https://archive.archlinux.org/repos/2026/09/01/$repo/os/$arch\n' for repo in ['core', 'extra']) +
                  '[work]\nInclude = /etc/pacman.d/work.conf\n')
        advanced = system.advance_snapshot(config, '2026/10/01')
        self.assertEqual(advanced, config.replace('/2026/09/01/', '/2026/10/01/'))
        with self.assertRaises(ValueError):
            system.advance_snapshot(config, '2026/08/01')
        with self.assertRaises(ValueError):
            system.advance_snapshot('[core]\nInclude = /etc/pacman.d/mirrorlist\n', '2026/10/01')


if __name__ == '__main__':
    unittest.main()
