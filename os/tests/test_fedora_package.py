"""Portable contract checks; real RPM lifecycle belongs to native Fedora."""
import importlib.machinery
import importlib.util
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
import fedora_payload as payload


def module(name, path):
    spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, str(path)))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


builder = module('fedora_builder', ROOT / 'os/tools/build-fedora-package.py')
operations = module('fedora_operations', ROOT / 'os/tools/hn-os')
update = module('fedora_updates', ROOT / 'os/live_update.py')


class FedoraPayload(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.runtime = self.folder / 'runtime'
        self.runtime.mkdir()
        elf = struct.pack('<16sHHIQQQIHHHHHH', b'\x7fELF\x02\x01\x01' + b'\0' * 9,
                          2, 183, 1, 0, 64, 0, 0, 64, 56, 0, 0, 0, 0)
        for name, data in [('harness-tui', elf), ('cli.js', b'cli'), ('notify.mjs', b'notify')]:
            (self.runtime / name).write_bytes(data)
        self.info = {'source_commit': 'a' * 40, 'dirty': False, 'architecture': 'aarch64',
                     'target': 'aarch64-unknown-linux-musl',
                     'files': {p.name: {'bytes': p.stat().st_size, 'sha256': payload.digest(p)}
                               for p in self.runtime.iterdir()}}
        (self.runtime / 'source.json').write_text(json.dumps(self.info))

    def test_explicit_runtime_producer_remains_separate_from_package_source(self):
        destination = self.folder / 'payload'
        result = payload.stage(ROOT, self.runtime, destination, 'b' * 40, 'a' * 40)
        self.assertEqual(result['runtime']['source_commit'], 'a' * 40)
        self.assertEqual(result['runtime']['package_source_commit'], 'b' * 40)
        self.assertEqual(result['runtime']['system_profile'], 'fedora')
        self.assertEqual(json.loads((self.runtime / 'source.json').read_text()), self.info)
        self.assertEqual((destination / 'usr/lib/harness/cli.mjs').read_bytes(), b'cli')
        self.assertEqual((destination / 'usr/lib/harness/harness-tui').read_bytes(),
                         (self.runtime / 'harness-tui').read_bytes())
        session = (destination / 'usr/lib/harness-os/session').read_text()
        self.assertIn('\nlabwc -C ', session)
        self.assertNotIn('/usr/lib/harness-os/labwc -C', session)
        self.assertNotIn('usr/lib/harness-os/labwc', result['files'])

    def test_inert_profile_contains_no_base_system_or_fixture_takeover(self):
        destination = self.folder / 'payload'
        result = payload.stage(ROOT, self.runtime, destination, 'b' * 40, 'a' * 40)
        self.assertTrue(all(path.startswith('usr/') for path in result['files']))
        for name in ['install.py', 'system.py', 'runtime_update.py', 'release_update.py']:
            self.assertNotIn('usr/lib/harness-os/' + name, result['files'])
        self.assertNotIn('usr/share/harness-os/lock.json', result['files'])
        self.assertIn('usr/lib/harness-os/live_update.py', result['files'])
        self.assertIn('usr/lib/harness-os/screen-action', result['files'])
        self.assertEqual((destination / 'usr/lib/harness-os/screen-action').stat().st_mode & 0o777, 0o755)
        self.assertIn('usr/lib/systemd/user/harness-update.timer', result['files'])
        self.assertEqual(result['symlinks']['usr/bin/harness-session'], '../lib/harness-os/session')
        self.assertEqual(result['symlinks']['usr/bin/harness-session-setup'], '../lib/harness-os/fedora_session.py')
        self.assertIn('usr/lib/harness-os/fedora_session.py', result['files'])
        self.assertIn('W-u', (destination / 'usr/share/harness-os/labwc/rc.xml').read_text())
        self.assertNotIn('W-i', (destination / 'usr/share/harness-os/labwc/rc.xml').read_text())
        self.assertNotIn('harness-install', (destination / 'usr/lib/systemd/user/harness-os.target').read_text())
        self.assertEqual((destination / 'usr/lib/systemd/user/harness-os.target').read_text(),
                         (ROOT / 'os/root/usr/lib/systemd/user/harness-os.target').read_text()
                         .replace(' harness-install.service', '').replace(' harness-gpu-check.timer', ''))
        guide = (destination / 'usr/share/harness-os/AGENTS.md').read_text()
        self.assertIn('Fedora', guide)
        self.assertNotIn('sudo pacman', guide)
        self.assertNotIn('sudo hn-os update', guide)
        inventory = builder.file_list(destination)
        self.assertNotIn('%dir /usr\n', inventory)
        self.assertNotIn('%dir /usr/lib/systemd/user\n', inventory)
        self.assertIn('%dir /usr/lib/harness\n', inventory)
        self.assertIn('%license /usr/share/licenses/harness-os/LICENSE\n', inventory)

    def test_rejects_producer_mismatch_corruption_and_symlink_runtime(self):
        with self.assertRaises(ValueError):
            payload.runtime_identity(self.runtime, 'b' * 40)
        binary = self.runtime / 'harness-tui'
        original = binary.read_bytes()
        binary.write_bytes(original + b'changed')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            payload.runtime_identity(self.runtime, 'a' * 40)
        binary.unlink()
        other = self.folder / 'binary'
        other.write_bytes(original)
        binary.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            payload.runtime_identity(self.runtime, 'a' * 40)

    def test_payload_tar_is_reproducible_and_preserves_runtime_bytes_modes(self):
        destination = self.folder / 'payload'
        payload.stage(ROOT, self.runtime, destination, 'b' * 40, 'a' * 40)
        first, second = self.folder / 'a.tar.gz', self.folder / 'b.tar.gz'
        builder.archive_payload(destination, first, 123456)
        builder.archive_payload(destination, second, 123456)
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with tarfile.open(first) as archive:
            binary = archive.getmember('usr/lib/harness/harness-tui')
            self.assertEqual((binary.uid, binary.gid, binary.mode, binary.mtime), (0, 0, 0o755, 123456))
            self.assertEqual(archive.extractfile(binary).read(), (self.runtime / 'harness-tui').read_bytes())
            self.assertTrue(archive.getmember('usr/bin/harness-session').issym())

    def test_fixture_rejects_wrong_package_source_corrupt_bytes_and_symlink(self):
        package = self.folder / 'harness-os-session-0.1.0-1.aarch64.rpm'
        package.write_bytes(b'private package identity fixture, not an installable RPM')
        metadata = {'schema': 1, 'kind': 'harness-os-fedora-session', 'architecture': 'aarch64',
                    'published': False, 'package_source_commit': 'b' * 40, 'runtime_source_commit': 'a' * 40,
                    'runtime': {'source_commit': 'a' * 40, 'system_profile': 'fedora'},
                    'package': {'name': package.name, 'bytes': package.stat().st_size, 'sha256': payload.digest(package)}}
        (self.folder / 'package-manifest.json').write_text(json.dumps(metadata))
        self.assertEqual(payload.package_identity(self.folder, 'b' * 40), metadata)
        with self.assertRaisesRegex(ValueError, 'exact-source'):
            payload.package_identity(self.folder, 'c' * 40)
        original = package.read_bytes()
        package.write_bytes(original + b'corrupt')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            payload.package_identity(self.folder, 'b' * 40)
        package.unlink()
        other = self.folder / 'other.rpm'
        other.write_bytes(original)
        package.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'checksum'):
            payload.package_identity(self.folder, 'b' * 40)


class FedoraOperations(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.identity = self.folder / 'runtime.json'
        self.identity.write_text('{"system_profile":"fedora","source_commit":"original"}\n')
        self.state = self.folder / 'state'
        self.state.mkdir()

    def test_fedora_system_commands_never_execute_pc_helpers(self):
        for command in ['install', 'checkpoint', 'update', 'recover', '_require-pc-system']:
            with self.subTest(command=command), patch.object(operations, 'RUNTIME_ID', self.identity), \
                    patch.object(sys, 'argv', ['hn-os', command]), patch.object(operations.os, 'execv') as execute:
                with self.assertRaisesRegex(SystemExit, 'Fedora integration package'):
                    operations.main()
                execute.assert_not_called()

    def test_fedora_status_uses_real_runtime_provenance_without_arch_lock(self):
        with patch.object(operations, 'RUNTIME_ID', self.identity), patch.object(sys, 'argv', ['hn-os']), \
                patch.object(operations.subprocess, 'run') as status, patch('builtins.print') as output:
            operations.main()
        self.assertEqual(output.call_args.args[0], self.identity.read_text())
        self.assertIn('hn-screen', status.call_args.args[0])

    def test_legacy_pc_packages_keep_their_system_operations(self):
        self.identity.write_text('{"source_commit":"older-PC-package"}\n')
        with patch.object(operations, 'RUNTIME_ID', self.identity):
            operations.require_pc_system()

    def test_fedora_check_clears_stale_system_error_without_loading_pc_module(self):
        update.write(self.state / 'system.json', {'available': True, 'error': 'old PC check'})
        with patch.object(update, 'BASE_ID', self.identity), patch.object(update, 'STATE', self.state), \
                patch.object(update.importlib.util, 'spec_from_file_location') as discover:
            result = update.check_system(force=True)
            self.assertEqual(result, {'supported': False, 'available': False})
            self.assertNotIn('error', update.read(self.state / 'system.json'))
            discover.assert_not_called()

    def test_stale_system_availability_cannot_execute_privileged_upgrade(self):
        update.write(self.state / 'system.json', {'available': True})
        with patch.object(update, 'BASE_ID', self.identity), patch.object(update, 'STATE', self.state), \
                patch.object(update, 'RESTART_REQUIRED', self.folder / 'absent'), \
                patch.object(update, 'prepared', return_value=None), patch.object(update.subprocess, 'run') as run:
            update.update_all()
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
