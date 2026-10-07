"""Startup identity/configuration boundaries; real boot is tested in the ARM VM."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('asahi_startup', Path(__file__).resolve().parents[1] /
                                               'platforms/apple-silicon/startup.py')
startup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(startup)


class Startup(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'etc/kernel').mkdir(parents=True)
        (self.root / 'etc/default').mkdir()
        (self.root / 'etc/kernel/cmdline').write_text('root=UUID=old ro rootflags=subvol=root quiet quiet\n')
        (self.root / 'etc/default/grub').write_text('GRUB_CMDLINE_LINUX_DEFAULT="rootflags=subvol=root"\nGRUB_TIMEOUT=5\n')
        self.payload = SimpleNamespace(root=self.root, esp=self.root / 'esp')
        self.state = {k: f'00000000-0000-4000-8000-00000000000{i}'
                      for i, k in enumerate(('root_uuid', 'boot_uuid', 'luks_uuid'), 1)}
        self.esp_uuid = '00000000-0000-4000-8000-000000000004'

    def test_disk_references_are_replaced_and_other_options_preserved(self):
        result = startup.configuration(self.payload, self.state, self.esp_uuid)
        self.assertNotIn('UUID=old', '\n'.join(result.values()))
        self.assertEqual(result['etc/kernel/cmdline'].split().count('quiet'), 1)
        self.assertIn('rd.luks.name=' + self.state['luks_uuid'] + '=harness-root', result['etc/kernel/cmdline'])
        self.assertIn('PARTUUID=' + self.esp_uuid, result['etc/fstab'])
        self.assertIn('crypt', result['etc/dracut.conf.d/20-harness-crypt.conf'])
        self.assertIn('GRUB_TIMEOUT=5', result['etc/default/grub'])
        self.assertNotIn('console=', result['etc/kernel/cmdline'])

    def test_changed_source_layout_stops(self):
        (self.root / 'etc/kernel/cmdline').write_text('root=/dev/vda3 quiet\n')
        with self.assertRaises(startup.Error):
            startup.configuration(self.payload, self.state, self.esp_uuid)

    def test_invalid_identifier_stops_before_config_generation(self):
        self.state['root_uuid'] = 'bad\nUUID=another'
        with self.assertRaises(ValueError):
            startup.configuration(self.payload, self.state, self.esp_uuid)

    def test_no_redirected_or_escaping_paths(self):
        (self.root / 'redirect').symlink_to(self.root / 'etc', target_is_directory=True)
        for name in ('redirect/fstab', '../fstab', '/etc/fstab'):
            with self.subTest(name=name), self.assertRaises(startup.Error):
                startup.checked(self.root, name)

    def test_receipt_is_bound_to_storage_and_boot_evidence(self):
        path = self.root / 'startup.json'
        identity = {'schema': 1, 'kind': 'harness-asahi-startup', 'storage_sha256': 'a' * 64}
        state = startup.record(path, identity)
        self.assertEqual(state['phase'], 'planned')
        for change in ({'storage_sha256': 'b' * 64}, {'phase': 'complete'}, {'extra': True}):
            path.write_text(json.dumps({**state, **change}))
            path.chmod(0o600)
            with patch.object(startup.target, 'private_file'), self.assertRaises(startup.Error):
                startup.record(path, identity)

    def test_efi_copy_is_arm_only_and_does_not_include_m1n1(self):
        for name in ('EFI/BOOT/BOOTAA64.EFI', 'EFI/BOOT/grubaa64.efi', 'EFI/BOOT/bootx64.efi',
                     'EFI/fedora/grub.cfg', 'm1n1/boot.bin'):
            p = self.payload.esp / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'fixture')
        files = startup.efi_files(self.payload, self.state)
        self.assertNotIn('m1n1/boot.bin', files)
        self.assertNotIn('EFI/BOOT/bootx64.efi', files)
        self.assertIn(self.state['boot_uuid'].encode(), files['EFI/fedora/grub.cfg'])
        self.assertIn(b'configfile ', files['EFI/fedora/grub.cfg'])

    def test_empty_or_multiline_password_refuses_without_opening_payload(self):
        for password in ('', 'a\nb', 'a\0b', 'a\rb'):
            with self.subTest(password=repr(password)), self.assertRaises(startup.Error):
                startup.finish(Path('/unused'), None, password)


if __name__ == '__main__':
    unittest.main()
