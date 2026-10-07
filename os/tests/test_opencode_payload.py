"""Verify agent provenance and reject corrupted/wrong-platform package inputs."""
import copy
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'os/tools'))
import opencode_payload as agent


def elf(machine=183, alignment=65536):
    header = struct.pack('<16sHHIQQQIHHHHHH', b'\x7fELF\x02\x01\x01' + b'\0' * 9,
                         2, machine, 1, 0, 64, 0, 0, 64, 56, 1, 0, 0, 0)
    return header + struct.pack('<IIQQQQQQ', 1, 5, 0, 0, 0, 120, 120, alignment)


def file_info(data):
    return {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}


class AgentPayload(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.archives = self.root / 'archives'
        self.archives.mkdir()
        self.lock = agent.read_lock()
        self.files = {'opencode': elf(), 'LICENSE': b'MIT fixture license\n'}
        self.metadata = {
            'binary': {'name': 'opencode-linux-arm64', 'version': self.lock['version'],
                       'os': ['linux'], 'cpu': ['arm64']},
            'license': {'name': 'opencode-ai', 'version': self.lock['version'], 'license': 'MIT',
                        'optionalDependencies': {'opencode-linux-arm64': self.lock['version']}},
        }
        self.rebuild()

    def rebuild(self):
        for name, data in self.files.items():
            self.lock['files'][name].update(file_info(data))
        for kind, entry in self.lock['archives'].items():
            path = self.archives / (entry['package'] + '-' + self.lock['version'] + '.tgz')
            with tarfile.open(path, 'w:gz') as archive:
                files = {'package/package.json': json.dumps(self.metadata[kind]).encode(),
                         **{self.lock['files'][name]['member']: data for name, data in self.files.items()
                            if self.lock['files'][name]['archive'] == kind}}
                for name, data in files.items():
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
            entry.update(file_info(path.read_bytes()))

    def prepare(self, name='payload'):
        output = self.root / name
        # A cache hit must use the declared bytes without contacting a service.
        with patch.object(agent.urllib.request, 'urlopen', side_effect=AssertionError('Unexpected download')):
            agent.prepare(self.lock, self.archives, output)
        return output

    def test_repeatable_offline_prepare_and_package_owned_binary_license(self):
        first, second = self.prepare(), self.prepare('again')
        self.assertEqual(agent.identity(first, self.lock), self.lock)
        for name in ['opencode', 'LICENSE', 'manifest.json']:
            self.assertEqual((first / name).read_bytes(), (second / name).read_bytes())
        destination = self.root / 'install'
        agent.stage(first, destination, self.lock)
        binary = destination / 'usr/lib/harness-opencode/opencode'
        self.assertEqual(binary.read_bytes(), self.files['opencode'])
        self.assertEqual(binary.stat().st_mode & 0o777, 0o755)
        self.assertEqual((destination / 'usr/bin/opencode').readlink(), Path('../lib/harness-opencode/opencode'))
        self.assertEqual((destination / 'usr/share/licenses/harness-opencode/LICENSE').read_bytes(), self.files['LICENSE'])
        self.assertEqual(json.loads((destination / 'usr/share/harness-os/opencode.json').read_text()), self.lock)
        self.assertFalse((destination / 'etc').exists())

    def test_cached_archive_corruption_is_rejected_without_partial_payload(self):
        path = next(self.archives.glob('opencode-linux-arm64-*'))
        path.write_bytes(path.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.prepare()
        self.assertFalse((self.root / 'payload').exists())

    def test_wrong_architecture_and_page_alignment_fail_despite_matching_hashes(self):
        for binary, message in [(elf(machine=62), 'ARM64'), (elf(alignment=4096), '16 KiB')]:
            with self.subTest(message=message):
                self.files['opencode'] = binary
                self.rebuild()
                with self.assertRaisesRegex(ValueError, message):
                    self.prepare()
                self.assertFalse((self.root / 'payload').exists())

    def test_package_version_and_license_dependency_must_match(self):
        for kind, key, value in [('binary', 'version', '9.9.9'), ('binary', 'cpu', ['x64']),
                                 ('license', 'license', 'proprietary'),
                                 ('license', 'optionalDependencies', {'opencode-linux-arm64': '9.9.9'})]:
            with self.subTest(kind=kind, key=key):
                original = copy.deepcopy(self.metadata)
                self.metadata[kind][key] = value
                self.rebuild()
                with self.assertRaises(ValueError):
                    self.prepare()
                self.assertFalse((self.root / 'payload').exists())
                self.metadata = original

    def test_missing_license_and_payload_corruption_cannot_enter_package(self):
        payload = self.prepare()
        license = payload / 'LICENSE'
        original = license.read_bytes()
        for action in ['missing', 'corrupt', 'symlink']:
            with self.subTest(action=action):
                license.unlink(missing_ok=True)
                if action == 'corrupt':
                    license.write_bytes(original + b'changed')
                elif action == 'symlink':
                    outside = self.root / 'license'
                    outside.write_bytes(original)
                    license.symlink_to(outside)
                with self.assertRaisesRegex(ValueError, 'checksum'):
                    agent.stage(payload, self.root / 'install', self.lock)
                self.assertFalse((self.root / 'install').exists())

    def test_rewritten_manifest_cannot_authorize_changed_binary(self):
        payload = self.prepare()
        (payload / 'opencode').write_bytes(elf() + b'changed')
        altered = copy.deepcopy(self.lock)
        altered['files']['opencode'].update(file_info((payload / 'opencode').read_bytes()))
        (payload / 'manifest.json').write_text(json.dumps(altered))
        with self.assertRaisesRegex(ValueError, 'reviewed lock'):
            agent.identity(payload, self.lock)

    def test_unsafe_archive_members_are_rejected_without_extracting(self):
        for name, kind, duplicate in [('/tmp/escape', tarfile.REGTYPE, False),
                                      ('package/../../escape', tarfile.REGTYPE, False),
                                      ('package/bin/opencode', tarfile.SYMTYPE, False),
                                      ('package/bin/opencode', tarfile.LNKTYPE, False),
                                      ('package/bin/opencode', tarfile.REGTYPE, True)]:
            with self.subTest(name=name, kind=kind, duplicate=duplicate):
                data = io.BytesIO()
                with tarfile.open(fileobj=data, mode='w') as archive:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    archive.addfile(entry)
                    if duplicate:
                        archive.addfile(entry)
                data.seek(0)
                with tarfile.open(fileobj=data) as archive, self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
                    agent.archive_members(archive)

    def test_lock_rejects_unpinned_urls_unbounded_size_and_wrong_platform(self):
        for area, key, value in [('binary', 'url', 'https://registry.npmjs.org/opencode/latest'),
                                 ('binary', 'bytes', 301 * 1024**2),
                                 ('binary', 'sha256', 'bad')]:
            changed = copy.deepcopy(self.lock)
            changed['archives'][area][key] = value
            path = self.root / 'lock.json'
            path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                agent.read_lock(path)


if __name__ == '__main__':
    unittest.main()
