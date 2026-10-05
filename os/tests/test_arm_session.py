"""Keep the graphical ARM fixture separate from PC installation/update artifacts."""
import json
from pathlib import Path
import tempfile
import unittest

from arm_boot import digest
from arm_session import runtime_identity, stage


class ARMFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        elf = bytearray(32)
        elf[:6] = b'\x7fELF\x02\x01'
        elf[18:20] = (183).to_bytes(2, 'little')
        for name, data in [('harness-tui', elf), ('cli.js', b'fixture'), ('notify.mjs', b'fixture')]:
            (self.runtime / name).write_bytes(data)
        self.info = {'source_commit': 'a' * 40, 'dirty': False, 'architecture': 'aarch64',
                     'target': 'aarch64-unknown-linux-musl',
                     'files': {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in self.runtime.iterdir()}}
        self.save()

    def save(self):
        (self.runtime / 'source.json').write_text(json.dumps(self.info))

    def test_rejects_wrong_source_target_and_dirty_payload(self):
        runtime_identity(self.runtime, 'a' * 40)
        for key, value in [('source_commit', 'b' * 40), ('dirty', True), ('architecture', 'x86_64'),
                           ('target', 'x86_64-unknown-linux-musl')]:
            original = self.info[key]
            self.info[key] = value
            self.save()
            with self.subTest(key=key), self.assertRaises(ValueError):
                runtime_identity(self.runtime, 'a' * 40)
            self.info[key] = original

    def test_rejects_modified_runtime_and_mislabelled_elf(self):
        binary = self.runtime / 'harness-tui'
        data = bytearray(binary.read_bytes())
        data[18:20] = (62).to_bytes(2, 'little')
        binary.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            runtime_identity(self.runtime, 'a' * 40)
        self.info['files']['harness-tui']['sha256'] = digest(binary)
        self.save()
        with self.assertRaisesRegex(ValueError, 'ARM64 ELF'):
            runtime_identity(self.runtime, 'a' * 40)

    def test_session_overlay_contains_no_pc_installer_or_update_services(self):
        destination = self.root / 'overlay'
        receipt = stage(self.runtime, destination, 'a' * 40)
        files = receipt['files']
        for path in ['usr/lib/harness-os/install.py', 'usr/lib/harness-os/runtime_update.py',
                     'usr/lib/systemd/user/harness-update.timer', 'etc/mkinitcpio.conf.d/20-harness-apple-keyboard.conf']:
            self.assertNotIn(path, files)
        self.assertEqual((destination / 'usr/lib/harness/hn').readlink(), Path('harness-tui'))
        self.assertEqual(receipt['runtime']['architecture'], 'aarch64')
        self.assertIn('chromium-browser', (destination / 'usr/bin/hn-browser').read_text())
        self.assertNotIn('--no-sandbox', (destination / 'usr/bin/hn-browser').read_text())


if __name__ == '__main__':
    unittest.main()
