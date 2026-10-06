import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import tomllib
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('update_fixture', Path(__file__).with_name('build-update-fixture.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def elf(machine):
    # This only tests format guards. CI builds and executes the actual runtime.
    return struct.pack('<16sHHIQQQIHHHHHH', b'\x7fELF\x02\x01\x01' + b'\0' * 9,
                       2, machine, 1, 0, 64, 0, 0, 64, 56, 0, 0, 0, 0)


class FixtureContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.versions = {'hn': '0.1.12', 'cli': '0.0.1'}
        self.baselines = {'cli': {'version': '0.3.58', 'commit': 'b' * 40}}

    def runtime(self, architecture):
        folder = self.root / architecture
        folder.mkdir()
        for name in fixture.FILES:
            (folder / name).write_bytes(elf(fixture.TARGETS[architecture][2]) if name == 'harness-tui' else name.encode())
        record = {'source_commit': 'a' * 40, 'dirty': False, 'architecture': architecture,
                  'target': architecture + '-unknown-linux-musl', 'versions': self.versions,
                  'release_baselines': self.baselines, 'files': {
                      name: {'sha256': fixture.digest(folder / name), 'bytes': (folder / name).stat().st_size}
                      for name in fixture.FILES}}
        self.write_record(folder, record)
        return folder, record

    def write_record(self, folder, record):
        (folder / 'source.json').write_text(json.dumps(record))

    def validate(self, folder, architecture='aarch64'):
        return fixture.validate_runtime(folder, 'a' * 40, architecture, self.versions, self.baselines)

    def test_accepts_complete_native_baseline_on_each_architecture(self):
        for architecture in ['x86_64', 'aarch64']:
            folder, record = self.runtime(architecture)
            with self.subTest(architecture=architecture):
                self.assertEqual(self.validate(folder, architecture), record)

    def test_rejects_stale_dirty_cross_arch_or_changed_ancestry_before_building(self):
        folder, original = self.runtime('aarch64')
        changes = {'source_commit': 'c' * 40, 'dirty': True, 'architecture': 'x86_64',
                   'target': 'x86_64-unknown-linux-musl', 'versions': {'hn': '0.1.11', 'cli': '0.0.1'},
                   'release_baselines': {}, 'files': list(fixture.FILES)}
        for key, value in changes.items():
            modified = copy.deepcopy(original)
            modified[key] = value
            self.write_record(folder, modified)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'exact clean source'):
                self.validate(folder)

    def test_rejects_truncated_tampered_missing_and_unexpected_runtime_files(self):
        folder, original = self.runtime('aarch64')
        cli = folder / 'cli.js'
        for payload in [b'x', b'changed payload']:
            cli.write_bytes(payload)
            with self.subTest(payload=payload), self.assertRaisesRegex(ValueError, 'failed verification'):
                self.validate(folder)
        cli.unlink()
        with self.assertRaisesRegex(ValueError, 'complete, unmodified'):
            self.validate(folder)
        cli.write_bytes(b'cli.js')
        (folder / 'stale-binary').touch()
        with self.assertRaisesRegex(ValueError, 'complete, unmodified'):
            self.validate(folder)

    def test_rejects_symlinked_artifacts_and_valid_hash_for_wrong_elf(self):
        folder, original = self.runtime('aarch64')
        binary = folder / 'harness-tui'
        binary.unlink()
        other = self.root / 'external-binary'
        other.write_bytes(elf(183))
        binary.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'failed verification'):
            self.validate(folder)
        binary.unlink()
        binary.write_bytes(elf(62))
        original['files']['harness-tui']['sha256'] = fixture.digest(binary)
        self.write_record(folder, original)
        with self.assertRaisesRegex(ValueError, 'native Linux ELF'):
            self.validate(folder)

    def test_version_probe_cannot_accept_a_fake_executable_or_wrong_version(self):
        binary = self.root / 'harness-tui'
        binary.write_text('#!/bin/sh\necho "hn 999.0.1"\n')
        with patch.object(fixture, 'command') as run:
            with self.assertRaisesRegex(ValueError, 'native Linux ELF'):
                fixture.probe_versions(self.root, 'aarch64', {'hn': fixture.VERSION, 'cli': fixture.VERSION}, 'cli.mjs')
            run.assert_not_called()
        binary.write_bytes(elf(183))
        with patch.object(fixture, 'command', side_effect=['hn 0.1.12 (tmux 3.7c)', fixture.VERSION]):
            with self.assertRaisesRegex(ValueError, 'expected versions'):
                fixture.probe_versions(self.root, 'aarch64', {'hn': fixture.VERSION, 'cli': fixture.VERSION}, 'cli.mjs')

    def test_architecture_metadata_checksums_and_existing_private_feed_contract(self):
        for architecture, key in [('x86_64', 'linux-x64'), ('aarch64', 'linux-arm64')]:
            folder = self.root / architecture
            folder.mkdir()
            for name in ['harness-tui', 'cli.mjs', 'notify.mjs', 'cli-current.mjs']:
                (folder / name).write_bytes(name.encode())
            fixture.write_manifests(folder, architecture, '0.0.1', '0.3.58')
            hn = json.loads((folder / 'hn.json').read_text())
            self.assertEqual(hn['version'], '999.0.1')
            self.assertEqual(set(hn['builds']), {key})
            documents = [hn['builds'], json.loads((folder / 'cli.json').read_text())['cli'],
                         json.loads((folder / 'cli-current.json').read_text())['cli']]
            for document in documents:
                for ref in document.values():
                    if isinstance(ref, dict):
                        self.assertTrue(ref['url'].startswith('http://127.0.0.1:19447/'))
                        data = (folder / ref['url'].rsplit('/', 1)[1]).read_bytes()
                        self.assertEqual(ref['sha256'], hashlib.sha256(data).hexdigest())
                        self.assertEqual(ref['size'], len(data))
            self.assertEqual(json.loads((folder / 'cli-ancestor.json').read_text())['cli']['version'], '0.3.58')
            for name in ['feeds-ancestor.json', 'feeds-hn.json', 'feeds-both.json']:
                for url in json.loads((folder / name).read_text()).values():
                    self.assertTrue((folder / url.rsplit('/', 1)[1]).is_file())


class SourceIsolation(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.git('init', '-b', 'main')
        (self.source / 'tui/src').mkdir(parents=True)
        (self.source / 'tui/Cargo.toml').write_text('[package]\nname = "harness-tui"\nversion = "0.1.12"\n')
        (self.source / 'tui/Cargo.lock').write_text('[[package]]\nname = "harness-tui"\nversion = "0.1.12"\n\n'
                                                  '[[package]]\nname = "dependency"\nversion = "1.0.0"\n')
        (self.source / 'tui/src/main.rs').write_text('fn main() {}\n')
        (self.source / '.gitignore').write_text('ignored.rs\n')
        self.git('add', '.')
        self.git('commit', '-m', 'baseline')

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), '-c', 'user.name=Fixture',
                                        '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null',
                                        *args], text=True, stderr=subprocess.DEVNULL).strip()

    def test_private_version_changes_only_tracked_temporary_source(self):
        commit = fixture.clean_source(self.source)
        (self.source / 'tui/src/ignored.rs').write_text('must not enter the fixture')
        output = self.root / 'copy'
        fixture.copy_tui(self.source, output)
        self.assertFalse((output / 'src/ignored.rs').exists())
        self.assertEqual(tomllib.loads((output / 'Cargo.toml').read_text())['package']['version'], '999.0.1')
        packages = tomllib.loads((output / 'Cargo.lock').read_text())['package']
        self.assertEqual({p['name']: p['version'] for p in packages}, {'harness-tui': '999.0.1', 'dependency': '1.0.0'})
        self.assertEqual(tomllib.loads((self.source / 'tui/Cargo.toml').read_text())['package']['version'], '0.1.12')
        self.assertEqual(fixture.clean_source(self.source), commit)

    def test_dirty_and_untracked_source_cannot_be_mislabeled_clean(self):
        tracked = self.source / 'tui/src/main.rs'
        original = tracked.read_text()
        tracked.write_text(original + '// changed\n')
        with self.assertRaisesRegex(ValueError, 'Commit source changes'):
            fixture.clean_source(self.source)
        tracked.write_text(original)
        (self.source / 'tui/src/untracked.rs').write_text('new source')
        with self.assertRaisesRegex(ValueError, 'Commit source changes'):
            fixture.clean_source(self.source)
