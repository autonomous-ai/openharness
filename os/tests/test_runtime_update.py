import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('runtime_update', Path(__file__).parents[1] / 'runtime_update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class BundleGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.version = '0.1.0pre4.r123.gabcdef1234-1'
        self.base = {'version': '0.1.0-preview.4', 'arch_snapshot': '2026/10/01'}
        self.runtime = {'dirty': False, 'source_commit': 'a' * 40, 'target': 'x86_64-unknown-linux-musl',
                        'files': {name: {'bytes': 7, 'sha256': hashlib.sha256(b'fixture').hexdigest()}
                                  for name in ['harness-tui', 'cli.mjs', 'notify.mjs']}}
        self.package = self.root / f'harness-os-{self.version}-x86_64.pkg.tar.gz'
        self.manifest = dict(schema=1, kind='harness-os-package', architecture='x86_64',
                             requires_os_version=self.base['version'], arch_snapshot=self.base['arch_snapshot'],
                             source_commit='a' * 40, runtime=self.runtime,
                             package={'name': self.package.name, 'version': self.version})
        self.make_package()

    def make_package(self, extra=None, pkgname='harness-os', bad_runtime=False):
        with tarfile.open(self.package, 'w:gz') as archive:
            files = {'.PKGINFO': f'pkgname = {pkgname}\npkgver = {self.version}\narch = x86_64\n'.encode(),
                     'usr/share/harness-os/runtime.json': json.dumps(self.runtime).encode()}
            files.update({'usr/lib/harness/' + name: b'changed' if bad_runtime else b'fixture' for name in self.runtime['files']})
            for name, data in files.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        self.manifest['package'].update(bytes=self.package.stat().st_size, sha256=update.digest(self.package))
        self.write_manifest()

    def write_manifest(self):
        (self.root / 'package-manifest.json').write_text(json.dumps(self.manifest))

    def test_complete_bundle_is_verified_without_installing(self):
        with patch.object(update.subprocess, 'run', side_effect=AssertionError('No install during validation')):
            manifest, package = update.validate_bundle(self.root, self.base)
        self.assertEqual(manifest, self.manifest)
        self.assertEqual(package, self.package)

    def test_incomplete_download_is_rejected_before_a_checkpoint_or_transaction(self):
        self.package.write_bytes(self.package.read_bytes()[:-10])
        with self.assertRaisesRegex(ValueError, 'checksum or size'):
            update.validate_bundle(self.root, self.base)

    def test_wrong_source_architecture_and_base_are_rejected(self):
        good = copy.deepcopy(self.manifest)
        for key, value in [('architecture', 'aarch64'), ('source_commit', 'b' * 40),
                           ('requires_os_version', '0.1.0-preview.2'), ('arch_snapshot', '2026/09/01')]:
            self.manifest = dict(good, **{key: value})
            self.write_manifest()
            with self.subTest(key=key), self.assertRaises(ValueError):
                update.validate_bundle(self.root, self.base)

    def test_package_identity_and_actual_runtime_must_match_manifest(self):
        for args in [{'pkgname': 'another-package'}, {'bad_runtime': True}]:
            self.make_package(**args)
            with self.subTest(args=args), self.assertRaises(ValueError):
                update.validate_bundle(self.root, self.base)

    def test_archive_cannot_escape_system_paths_or_execute_install_script(self):
        for name in ['../escape', '/etc/escape', 'home/me/project', '.INSTALL', 'usr/../escape', 'usr/lib/harness/cli.mjs']:
            member = tarfile.TarInfo(name)
            self.make_package(extra=member)
            with self.subTest(name=name), self.assertRaises(ValueError):
                update.validate_bundle(self.root, self.base)
        for name, target in [('usr/bad', '/home/me'), ('usr/bad', '../../home/me'), ('usr/lib/harness', 'somewhere')]:
            member = tarfile.TarInfo(name)
            member.type, member.linkname = tarfile.SYMTYPE, target
            self.make_package(extra=member)
            with self.subTest(link=(name, target)), self.assertRaises(ValueError):
                update.validate_bundle(self.root, self.base)

    def test_backup_only_includes_package_owned_paths_and_preserves_symlink(self):
        snapshot = self.root / 'snapshot'
        db = snapshot / 'var/lib/pacman/local/harness-os-1-1'
        db.mkdir(parents=True)
        (db / 'desc').write_text('%NAME%\nharness-os\n\n%VERSION%\n1-1\n\n%ARCH%\nx86_64\n\n%DEPENDS%\nnodejs-lts-jod\n')
        (db / 'files').write_text('%FILES%\nusr/\nusr/lib/\nusr/lib/harness/\nusr/lib/harness/harness-tui\nusr/lib/harness/hn\n')
        library = snapshot / 'usr/lib/harness'
        library.mkdir(parents=True)
        (library / 'harness-tui').write_bytes(b'previous executable')
        (library / 'harness-tui').chmod(0o755)
        (library / 'hn').symlink_to('harness-tui')
        (library / 'unowned-user-file').write_text('do not package')
        backup = self.root / 'backup.pkg.tar.gz'
        # Fixture files belong to the test runner, unlike the real root snapshot.
        original = tarfile.TarFile.add
        def root_owned(archive, name, *args, **kwargs):
            def ownership(info):
                info.uid = info.gid = 0
                return info
            return original(archive, name, *args, filter=ownership, **kwargs)
        with patch.object(tarfile.TarFile, 'add', root_owned):
            update.package_backup(snapshot, '1-1', backup)
        with tarfile.open(backup) as archive:
            self.assertNotIn('usr/lib/harness/unowned-user-file', archive.getnames())
            self.assertEqual(archive.getmember('usr/lib/harness/hn').linkname, 'harness-tui')
            self.assertEqual(archive.getmember('usr/lib/harness/harness-tui').mode, 0o755)
            self.assertIn(b'depend = nodejs-lts-jod', archive.extractfile('.PKGINFO').read())

    def test_rollback_rejects_corrupt_backup_without_touching_package_database(self):
        receipt = {'id': '20261003T120000Z-12345678', 'status': 'applied', 'root_uuid': 'test-root',
                   'backup_sha256': '0' * 64}
        folder = self.root / receipt['id']
        folder.mkdir()
        (folder / 'previous.pkg.tar.gz').write_bytes(b'bad backup')
        with patch.object(update, 'STATE', self.root), patch.object(update, 'latest', return_value=receipt), \
                patch.object(update, 'install_package', side_effect=AssertionError('No transaction')):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                update.rollback(None, {'root_uuid': 'test-root'})


if __name__ == '__main__':
    unittest.main()
