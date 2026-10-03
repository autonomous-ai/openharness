import importlib.util
from contextlib import ExitStack
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

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


class InterruptedUpdates(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / 'pacman.conf'
        self.config.write_text('[core]\nServer = https://archive.archlinux.org/repos/2026/09/01/$repo/os/$arch\n')
        self.receipt = self.root / 'update.json'
        self.snapshots = self.root / 'snapshots'
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        for key, value in [('PACMAN_CONFIG', self.config), ('UPDATE_RECEIPT', self.receipt), ('CHECKPOINTS', self.snapshots)]:
            self.context.enter_context(patch.object(system, key, value))
        self.installed = self.context.enter_context(patch.object(system, 'installed', return_value={'root_uuid': 'this-system'}))
        self.pacman = self.context.enter_context(patch.object(system.subprocess, 'run'))

    def save_checkpoint(self, reason):
        name = 'before-update-123'
        folder = self.snapshots / name
        (folder / 'root').mkdir(parents=True)
        (folder / 'checkpoint.json').write_text(json.dumps({
            'root_uuid': 'this-system', 'boot_uuid': 'ABCD-1234',
            'boot_sha256': {name: 'digest' for name in ['vmlinuz-linux-lts', 'initramfs-linux-lts.img', 'grub/grub.cfg']}}))
        return name

    def test_failed_update_blocks_packages_and_retry_retains_original_checkpoint(self):
        with patch.object(system, 'checkpoint', side_effect=self.save_checkpoint) as save:
            def failed_pacman(argv):
                self.assertEqual(argv, ['pacman', '-Syyu'])
                pending = system.pending_update()
                self.assertIsNone(pending['exit_status'])
                self.assertEqual(pending['checkpoint'], 'before-update-123')
                self.assertIn('/2026/10/01/', self.config.read_text())
                return subprocess.CompletedProcess(argv, 1)
            self.pacman.side_effect = failed_pacman
            with self.assertRaisesRegex(ValueError, 'retry before changing packages'):
                system.update('2026/10/01')
            self.assertEqual(system.pending_update()['exit_status'], 1)
            self.pacman.side_effect = None
            self.pacman.return_value = subprocess.CompletedProcess(['pacman'], 0)
            system.update('2026/10/01')
            save.assert_called_once_with('before-update')
        self.assertIsNone(system.pending_update())
        self.assertEqual(json.loads(self.receipt.read_text())['checkpoint'], 'before-update-123')

    def test_keyboard_interrupt_leaves_a_persistent_package_guard(self):
        with patch.object(system, 'checkpoint', side_effect=self.save_checkpoint):
            self.pacman.side_effect = KeyboardInterrupt
            with self.assertRaises(KeyboardInterrupt):
                system.update('2026/10/01')
        self.assertIsNone(system.pending_update()['exit_status'])
        self.installed.reset_mock()
        with self.assertRaisesRegex(ValueError, 'full system update did not finish'):
            system.checkpoint(pacman_hook=True)
        self.installed.assert_not_called()

    def test_failed_preview_receipt_also_blocks_package_transactions(self):
        self.receipt.write_text(json.dumps({'snapshot': '2026/10/01', 'checkpoint': 'before-update-123', 'exit_status': 1}))
        with self.assertRaisesRegex(ValueError, 'full system update did not finish'):
            system.checkpoint(pacman_hook=True)
        self.installed.assert_not_called()

    def test_retry_refuses_a_missing_or_unrelated_recovery_checkpoint(self):
        name = self.save_checkpoint('before-update')
        self.receipt.write_text(json.dumps({'snapshot': '2026/10/01', 'checkpoint': name, 'exit_status': None}))
        (self.snapshots / name / 'root').rmdir()
        with self.assertRaisesRegex(ValueError, 'checkpoint is missing'):
            system.update('2026/10/01')
        (self.snapshots / name / 'root').mkdir()
        self.installed.return_value = {'root_uuid': 'another-system'}
        with self.assertRaisesRegex(ValueError, 'different root filesystem'):
            system.update('2026/10/01')
        self.pacman.assert_not_called()

    def test_corrupt_update_receipt_does_not_allow_a_package_transaction(self):
        for value in ['{broken', '[]', '{}', '{"snapshot":"2026/10/01","checkpoint":"../outside"}']:
            self.receipt.write_text(value)
            with self.assertRaises(ValueError):
                system.checkpoint(pacman_hook=True)
        self.installed.assert_not_called()


if __name__ == '__main__':
    unittest.main()
