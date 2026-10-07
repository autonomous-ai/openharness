import copy
import importlib.util
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


payload = load('compositor_payload', ROOT / 'os/tools/compositor_payload.py')
builder = load('compositor_package', ROOT / 'os/tools/build-package.py')
updater = load('compositor_update', ROOT / 'os/runtime_update.py')


class CompositorPackage(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'checkout'
        self.bundle = self.root / 'compositor'
        self.bundle.mkdir()
        # Format-only fixture: native ELF loading and real lock privacy have a
        # separate compiler/VM gate. These tests exercise package ownership.
        header = bytearray(64)
        header[:7] = b'\x7fELF\x02\x01\x01'
        header[18:20] = (62).to_bytes(2, 'little')
        (self.bundle / 'labwc').write_bytes(header)
        (self.bundle / 'source.tar.gz').write_bytes(b'corresponding source fixture')
        (self.bundle / 'LICENSE').write_text('GPL-2.0-only fixture\n')
        self.pin = dict(version='0.20.2', patch='session-lock-presentation.patch',
                        **payload.identity(self.bundle / 'source.tar.gz'))
        originals = {'source.json': 'os/packaging/labwc/source.json',
                     'session-lock-presentation.patch': 'os/packaging/labwc/session-lock-presentation.patch',
                     'rebuild.sh': 'os/packaging/labwc/rebuild.sh',
                     'build-compositor.py': 'os/tools/build-compositor.py',
                     'lock_presentation_policy.c': 'os/tests/lock_presentation_policy.c'}
        for name, relative in originals.items():
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(self.pin) if name == 'source.json' else 'source for ' + name)
            shutil.copyfile(path, self.bundle / name)
        self.record = dict(schema=1, kind='harness-compositor', architecture='x86_64',
                           source_commit='a' * 40, upstream=self.pin,
                           binary=dict(name='labwc', **payload.identity(self.bundle / 'labwc')),
                           runtime_dependencies=['glibc', 'wayland', 'wlroots0.20'],
                           build_options=['-Dxwayland=enabled'],
                           corresponding_source={name: payload.identity(self.bundle / name)
                                                 for name in [*originals, 'source.tar.gz', 'LICENSE']})
        self.save()

    def save(self):
        (self.bundle / 'manifest.json').write_text(json.dumps(self.record))

    def test_compositor_source_and_library_dependencies_belong_to_one_os_package(self):
        destination = self.root / 'stage'
        (destination / 'usr/share/harness-os').mkdir(parents=True)
        record = payload.stage(self.source, self.bundle, destination, 'a' * 40)
        archive = self.root / 'os.pkg.tar.gz'
        builder.archive_package(destination, archive, builder.package_info(
            '1-1', 1234, 100, record['runtime_dependencies']), 1234)
        updater.inspect_package(archive, '1-1')
        with tarfile.open(archive) as package:
            self.assertEqual(package.getmember('usr/lib/harness-os/labwc').mode, 0o755)
            self.assertNotIn('usr/bin/labwc', package.getnames())
            for name, identity in self.record['corresponding_source'].items():
                member = package.getmember('usr/share/licenses/harness-os/labwc/' + name)
                self.assertEqual(member.size, identity['bytes'])
                self.assertEqual(member.mode, 0o644)
            metadata = package.extractfile('.PKGINFO').read().decode()
            for dependency in record['runtime_dependencies']:
                self.assertIn('depend = ' + dependency + '\n', metadata)
            self.assertNotIn('depend = labwc\n', metadata)
            self.assertIn('license = GPL-2.0-only\n', metadata)

    def test_existing_snapshot_backup_retains_the_actual_compositor_and_source(self):
        snapshot = self.root / 'snapshot'
        (snapshot / 'usr/share/harness-os').mkdir(parents=True)
        payload.stage(self.source, self.bundle, snapshot, 'a' * 40)
        owned = [str(p.relative_to(snapshot)) for p in snapshot.rglob('*') if p.is_file()]
        db = snapshot / 'var/lib/pacman/local/harness-os-1-1'
        db.mkdir(parents=True)
        (db / 'desc').write_text('%NAME%\nharness-os\n\n%VERSION%\n1-1\n\n%ARCH%\nx86_64\n')
        (db / 'files').write_text('%FILES%\n' + '\n'.join(owned) + '\n')
        (snapshot / 'usr/lib/harness-os/user-file').write_text('preserve; not package-owned')
        original = tarfile.TarFile.add
        def root_owned(archive, name, *args, **kwargs):
            def ownership(info):
                info.uid = info.gid = 0
                return info
            return original(archive, name, *args, filter=ownership, **kwargs)
        backup = self.root / 'rollback.pkg.tar.gz'
        with patch.object(tarfile.TarFile, 'add', root_owned):
            updater.package_backup(snapshot, '1-1', backup)
        with tarfile.open(backup) as archive:
            self.assertEqual(set(archive.getnames()), {*owned, '.PKGINFO'})
            for name in owned:
                self.assertEqual(archive.extractfile(name).read(), (snapshot / name).read_bytes())
            self.assertEqual(archive.getmember('usr/lib/harness-os/labwc').mode, 0o755)

    def test_wrong_build_architecture_source_or_missing_xwayland_is_rejected(self):
        good = copy.deepcopy(self.record)
        for changes in [dict(source_commit='b' * 40), dict(architecture='aarch64'),
                        dict(upstream={}), dict(build_options=[]),
                        dict(runtime_dependencies=['glibc']),
                        dict(runtime_dependencies=[{}]),
                        dict(runtime_dependencies=['glibc', 'wayland', 'wlroots0.20', '../other'])]:
            with self.subTest(changes=changes):
                self.record = dict(good, **changes)
                self.save()
                with self.assertRaises(ValueError):
                    payload.validate(self.source, self.bundle, 'a' * 40)

    def test_incomplete_binary_or_corresponding_source_cannot_ship(self):
        for name in ['labwc', *self.record['corresponding_source']]:
            path = self.bundle / name
            original = path.read_bytes()
            with self.subTest(name=name):
                path.write_bytes(original + b'changed')
                with self.assertRaises(ValueError):
                    payload.validate(self.source, self.bundle, 'a' * 40)
            path.write_bytes(original)
        self.record['corresponding_source'].pop('LICENSE')
        self.save()
        with self.assertRaisesRegex(ValueError, 'source or license'):
            payload.validate(self.source, self.bundle, 'a' * 40)

    def test_changed_checkout_patch_cannot_reuse_old_native_build(self):
        (self.source / 'os/packaging/labwc/session-lock-presentation.patch').write_text('new correction')
        with self.assertRaisesRegex(ValueError, 'differs from this checkout'):
            payload.validate(self.source, self.bundle, 'a' * 40)


if __name__ == '__main__':
    unittest.main()
