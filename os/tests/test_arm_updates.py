"""Reject mislabeled/corrupted private ARM updates before starting a VM."""
import copy
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
        self.root = Path(temporary.name)
        self.folder = self.root / 'updates'
        self.folder.mkdir()
        # Format-validation fixture only; this is deliberately not executable.
        binary = bytearray(64)
        binary[:7] = b'\x7fELF\x02\x01\x01'
        binary[18:20] = (183).to_bytes(2, 'little')
        (self.folder / 'harness-tui').write_bytes(binary)
        for name in ['cli.mjs', 'notify.mjs', 'cli-current.mjs']:
            (self.folder / name).write_text('format fixture ' + name)
        base_url = 'http://127.0.0.1:19447/'

        def ref(name):
            path = self.folder / name
            return {'url': base_url + name, 'sha256': digest(path), 'size': path.stat().st_size}

        documents = {
            'hn.json': {'version': '999.0.1', 'builds': {'linux-arm64': ref('harness-tui')}},
            'cli.json': {'cli': {'version': '999.0.1', 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
            'cli-current.json': {'cli': {'version': '0.0.1', 'cli': ref('cli-current.mjs'), 'notify': ref('notify.mjs')}},
            'cli-ancestor.json': {'cli': {'version': '0.3.58', 'cli': ref('cli.mjs'), 'notify': ref('notify.mjs')}},
            'feeds-ancestor.json': {'cli': base_url + 'cli-ancestor.json'},
            'feeds-hn.json': {'hn': base_url + 'hn.json', 'cli': base_url + 'cli-current.json'},
            'feeds-both.json': {'hn': base_url + 'hn.json', 'cli': base_url + 'cli.json'},
        }
        for name, document in documents.items():
            (self.folder / name).write_text(json.dumps(document))
        self.info = {'status': 'prepared', 'published': False, 'source_commit': 'a' * 40,
                     'architecture': 'aarch64', 'target': 'aarch64-unknown-linux-musl',
                     'version': '999.0.1',
                     'runtime': {'versions': {'cli': '0.0.1'},
                                 'release_baselines': {'cli': {'version': '0.3.58'}}},
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
        target = self.root / 'elsewhere'
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

    def test_unmanifested_files_directories_and_symlinks_are_not_served(self):
        path = self.folder / 'unverified'
        for kind in ['file', 'directory', 'symlink']:
            if kind == 'file':
                path.write_text('must not be served')
            elif kind == 'directory':
                path.mkdir()
            else:
                path.symlink_to(self.root / 'not-an-artifact')
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, 'unverified entries'):
                update_identity(self.folder, 'a' * 40)
            path.rmdir() if kind == 'directory' else path.unlink()

    def test_matching_outer_hash_does_not_allow_unbound_release_or_feed_references(self):
        wrong_notify = json.loads((self.folder / 'cli.json').read_text())['cli']['cli']
        changes = [
            ('hn.json', ('version',), '1.2.3'),
            ('hn.json', ('builds', 'linux-arm64', 'url'), 'https://example.test/another-hn'),
            ('hn.json', ('builds', 'linux-arm64', 'sha256'), 'f' * 64),
            ('hn.json', ('builds', 'linux-arm64', 'size'), 999),
            ('cli.json', ('cli', 'notify'), wrong_notify),
            ('cli-current.json', ('cli', 'version'), '999.0.1'),
            ('cli-ancestor.json', ('cli', 'version'), '999.0.1'),
            ('feeds-ancestor.json', ('cli',), 'http://127.0.0.1:19447/cli.json'),
            ('feeds-hn.json', ('hn',), 'http://127.0.0.1:19447/cli.json'),
            ('feeds-both.json', ('cli',), 'https://example.test/cli.json'),
        ]
        for name, keys, value in changes:
            path = self.folder / name
            original = path.read_bytes()
            document = copy.deepcopy(json.loads(original))
            target = document
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            path.write_text(json.dumps(document))
            self.info['files'][name] = digest(path)
            self.save()
            with self.subTest(name=name, keys=keys), self.assertRaisesRegex(ValueError, 'verified local assets'):
                update_identity(self.folder, 'a' * 40)
            path.write_bytes(original)
            self.info['files'][name] = digest(path)
            self.save()

    def test_baseline_versions_are_required_for_current_and_ancestor_feeds(self):
        self.info.pop('runtime')
        self.save()
        with self.assertRaisesRegex(ValueError, 'Missing original CLI versions'):
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
