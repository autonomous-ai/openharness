import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch


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

    def test_standalone_bootstrap_includes_and_loads_its_transitive_helpers(self):
        source = Path(__file__).resolve().parents[2]
        spec = importlib.util.spec_from_file_location('build_package', source / 'os/tools/build-package.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        folder = self.root / 'standalone'
        folder.mkdir()
        paths = builder.bootstrap(source, folder)
        self.assertEqual({p.name for p in paths}, set(update.BOOTSTRAP_FILES))
        spec = importlib.util.spec_from_file_location('isolated_bootstrap', folder / 'apply-update.py')
        standalone = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(standalone)
        self.assertEqual(standalone.validate_bundle(self.root, self.base)[1], self.package)
        # Resolve imports from this standalone folder, without installed files.
        helper = standalone.boot_module().module('t2_install').helper()
        helper.check_model('MacBookAir9,1')
        self.assertEqual(Path(helper.__file__).parent, folder)
        kernel = standalone.boot_module().module('t2_update').KERNEL
        self.assertEqual(Path(kernel.__file__).parent, folder)

    def test_kernel_and_harness_use_one_pacman_transaction(self):
        kernel = self.root / 'linux-t2.pkg.tar.zst'
        with patch.object(update.subprocess, 'run') as run, \
                patch.object(update, 'installed_version', return_value=self.version), \
                patch.object(update, 'verify_runtime'):
            update.install_package(self.package, self.version, self.runtime, [kernel])
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0], ['pacman', '--noconfirm', '-U', str(kernel), str(self.package)])

    def test_dependency_prefetch_includes_kernel_without_installing(self):
        kernel = self.root / 'linux-t2.pkg.tar.zst'
        with patch.object(update.subprocess, 'run') as run:
            update.prepare_packages(self.package, [kernel])
        run.assert_called_once_with(['pacman', '--noconfirm', '-U', '--downloadonly',
                                    str(kernel), str(self.package)], check=True)

    def test_missing_dependency_download_leaves_receipt_and_checkpoint_untouched(self):
        state = self.root / 'state'
        state.mkdir()
        previous = state / 'latest.json'
        previous.write_text('{"id":"previous-good-update"}')
        checkpoints = self.root / 'checkpoints'
        checkpoints.mkdir()
        runtime = self.root / 'runtime.json'
        runtime.write_text(json.dumps(self.runtime))
        restart = self.root / 'restart.json'
        system = SimpleNamespace(CHECKPOINTS=checkpoints, snapshot_date=lambda x: x,
                                 write_json=lambda path, value: path.write_text(json.dumps(value)),
                                 checkpoint=Mock(side_effect=AssertionError('No checkpoint before downloads')))
        boot = SimpleNamespace(prepare_update=lambda *args: None)
        with patch.object(update, 'STATE', state), patch.object(update, 'RUNTIME', runtime), \
                patch.object(update, 'RESTART_REQUIRED', restart), \
                patch.object(update, 'latest', return_value={'status': 'applied'}), \
                patch.object(update, 'boot_module', return_value=boot), \
                patch.object(update, 'validate_bundle', return_value=(self.manifest, self.package)), \
                patch.object(update, 'installed_version', return_value='older-1'), \
                patch.object(update.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'pacman')):
            with self.assertRaises(subprocess.CalledProcessError):
                update.apply(self.root, system, self.base, {'root_uuid': 'test-root'})
        system.checkpoint.assert_not_called()
        self.assertEqual(previous.read_text(), '{"id":"previous-good-update"}')
        self.assertEqual(list(checkpoints.iterdir()), [])
        self.assertFalse(restart.exists())

    def test_legacy_rollback_completes_after_package_removes_platform_helper(self):
        folder = self.root / 'installed'
        folder.mkdir()
        for name in ('runtime_update.py', 'boot_profile.py'):
            (folder / name).write_bytes((Path(__file__).parents[1] / name).read_bytes())
        spec = importlib.util.spec_from_file_location('installed_updater', folder / 'runtime_update.py')
        installed = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installed)
        receipt = {'id': '20261003T120000Z-12345678', 'status': 'applied', 'root_uuid': 'test-root',
                   'previous_version': self.version, 'previous_runtime': self.runtime,
                   'backup_sha256': update.digest(self.package)}
        backup = self.root / receipt['id']
        backup.mkdir()
        (backup / 'previous.pkg.tar.gz').write_bytes(self.package.read_bytes())
        calls = []
        system = SimpleNamespace(write_json=lambda path, value: path.write_text(json.dumps(value)),
                                 run=lambda *args: calls.append(args))
        with patch.object(installed, 'STATE', self.root), patch.object(installed, 'latest', return_value=receipt), \
                patch.object(installed, 'RESTART_REQUIRED', self.root / 'restart.json'), \
                patch.object(installed, 'install_package', side_effect=lambda *args: (folder / 'boot_profile.py').unlink()):
            installed.rollback(system, {'root_uuid': 'test-root'})
        self.assertFalse((folder / 'boot_profile.py').exists())
        self.assertEqual(receipt['status'], 'rolled-back')
        self.assertEqual(calls, [('mkinitcpio', '-P')])
        self.assertEqual(json.loads((self.root / 'restart.json').read_text())['status'], 'ready')

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

    def test_release_migration_requires_an_explicit_matching_base(self):
        self.manifest['requires_os_version'] = '0.1.0-preview.5'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'different Harness base'):
            update.validate_bundle(self.root, self.base)
        self.manifest['upgrades_from'] = [self.base]
        self.write_manifest()
        self.assertEqual(update.validate_bundle(self.root, self.base)[1], self.package)
        for value in [None, {}, 'any', [{'version': self.base['version']}]]:
            self.manifest['upgrades_from'] = value
            self.write_manifest()
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'migration list'):
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
