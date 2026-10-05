"""Reject mislabeled/corrupted private ARM updates before starting a VM."""
import json
from pathlib import Path
import tempfile
import unittest

from arm_boot import digest
from arm_update_vm import update_identity


class ARMUpdateInputs(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        # Format-validation fixture only; this is deliberately not executable.
        binary = bytearray(64)
        binary[:7] = b'\x7fELF\x02\x01\x01'
        binary[18:20] = (183).to_bytes(2, 'little')
        (self.folder / 'harness-tui').write_bytes(binary)
        for name in ['cli.mjs', 'notify.mjs', 'cli-current.mjs', 'cli.json',
                     'cli-current.json', 'cli-ancestor.json', 'feeds-ancestor.json',
                     'feeds-hn.json', 'feeds-both.json']:
            (self.folder / name).write_text('format fixture')
        (self.folder / 'hn.json').write_text(json.dumps({'builds': {'linux-arm64': {}}}))
        self.info = {'status': 'prepared', 'published': False, 'source_commit': 'a' * 40,
                     'architecture': 'aarch64', 'target': 'aarch64-unknown-linux-musl',
                     'version': '999.0.1',
                     'files': {p.name: digest(p) for p in self.folder.iterdir()}}
        self.save()

    def save(self):
        (self.folder / 'fixture.json').write_text(json.dumps(self.info))

    def test_retains_the_actual_producer_source(self):
        self.assertEqual(update_identity(self.folder, 'a' * 40)['source_commit'], 'a' * 40)
        with self.assertRaisesRegex(ValueError, 'exact-source'):
            update_identity(self.folder, 'b' * 40)

    def test_rejects_published_or_wrong_architecture_inputs(self):
        for key, wrong in [('published', True), ('architecture', 'x86_64'),
                           ('target', 'x86_64-unknown-linux-musl'), ('status', 'passed')]:
            original = self.info[key]
            self.info[key] = wrong
            self.save()
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'native ARM'):
                update_identity(self.folder, 'a' * 40)
            self.info[key] = original

    def test_corruption_and_symlinks_do_not_borrow_checksums(self):
        path = self.folder / 'cli.mjs'
        original = path.read_bytes()
        path.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            update_identity(self.folder, 'a' * 40)
        target = self.folder / 'elsewhere'
        target.write_bytes(original)
        path.unlink()
        path.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            update_identity(self.folder, 'a' * 40)

    def test_rejects_other_file_names_before_resolving_them(self):
        self.info['files']['../elsewhere'] = self.info['files'].pop('cli.mjs')
        self.save()
        with self.assertRaisesRegex(ValueError, 'incomplete'):
            update_identity(self.folder, 'a' * 40)

    def test_elf_and_release_entry_must_both_be_arm(self):
        path = self.folder / 'harness-tui'
        original = path.read_bytes()
        wrong = bytearray(original)
        wrong[18:20] = (62).to_bytes(2, 'little')
        path.write_bytes(wrong)
        self.info['files'][path.name] = digest(path)
        self.save()
        with self.assertRaisesRegex(ValueError, 'native ARM64 ELF'):
            update_identity(self.folder, 'a' * 40)
        path.write_bytes(original)
        self.info['files'][path.name] = digest(path)
        manifest = self.folder / 'hn.json'
        manifest.write_text(json.dumps({'builds': {'linux-x64': {}}}))
        self.info['files'][manifest.name] = digest(manifest)
        self.save()
        with self.assertRaisesRegex(ValueError, 'linux-arm64 release'):
            update_identity(self.folder, 'a' * 40)


if __name__ == '__main__':
    unittest.main()
