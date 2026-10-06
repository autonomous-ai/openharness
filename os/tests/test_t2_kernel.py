import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('t2_kernel', Path(__file__).parents[1] / 'tools/prepare-t2-kernel.py')
t2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t2)


class T2KernelBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / 'kernel.pkg.tar.zst'
        self.lock = {'schema': 1, 'platform': 'apple-t2', 'architecture': 'x86_64',
                     'kernel_release': '7.2.8-test-t2', 'pkgbase': 'linux-t2',
                     'early_modules': ['t2bce_vhci'], 'required_modules': ['t2bce_vhci'],
                     'package': {'name': 'linux-t2', 'version': '7.2.8-1', 'filename': self.package.name}}
        prefix = 'usr/lib/modules/7.2.8-test-t2/'
        self.files = {'.PKGINFO': b'pkgname = linux-t2\npkgbase = linux-t2\npkgver = 7.2.8-1\narch = x86_64\n',
                      prefix + 'pkgbase': b'linux-t2\n', prefix + 'vmlinuz': bytes(0x202) + b'HdrS',
                      prefix + 'kernel/t2bce_vhci.ko.zst': b'module fixture'}
        self.write_package()

    def write_package(self, extra=None):
        archive = self.root / 'kernel.tar'
        with tarfile.open(archive, 'w') as output:
            for name, data in self.files.items():
                member = tarfile.TarInfo(name)
                member.mode, member.size = 0o644, len(data)
                output.addfile(member, io.BytesIO(data))
            if extra is not None:
                output.addfile(extra, io.BytesIO(b''))
        subprocess.run(['zstd', '-q', '-f', str(archive), '-o', str(self.package)], check=True, timeout=10)
        self.lock['package'].update(t2.identity(self.package))

    def test_exact_archive_is_staged_without_extracting_package_paths(self):
        lock = self.root / 'lock.json'
        lock.write_text(json.dumps(self.lock))
        output = self.root / 'bundle'
        receipt = t2.prepare(self.package, output, lock)
        self.assertEqual(len(receipt['verified_files']), 4)
        self.assertEqual(t2.identity(output / self.package.name), t2.identity(self.package))
        self.assertFalse((self.root / 'usr').exists())
        with self.assertRaisesRegex(ValueError, 'fresh'):
            t2.prepare(self.package, output, lock)

    def test_live_profile_and_runtime_package_have_no_file_conflicts(self):
        source = Path(__file__).resolve().parents[2]
        def load(name, path):
            spec = importlib.util.spec_from_file_location(name, path)
            value = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(value)
            return value
        profile = load('image_profile', source / 'os/tools/configure-boot-profile.py')
        package = load('image_package', source / 'os/tools/build-package.py')
        selected = profile.boot.profile('apple-t2')
        self.lock.update(early_modules=selected['modules'], required_modules=selected['modules'],
                         kernel_parameters=selected['parameters'])
        for name in selected['modules']:
            self.files['usr/lib/modules/7.2.8-test-t2/kernel/' + name + '.ko.zst'] = b'module fixture'
        self.write_package()
        lock = self.root / 'lock.json'
        lock.write_text(json.dumps(self.lock))
        runtime = self.root / 'runtime'
        runtime.mkdir()
        # Assembly checks do not execute this format-only ELF fixture.
        (runtime / 'harness-tui').write_bytes(b'\x7fELF\x02\x01' + bytes(12) + b'\x3e\x00')
        (runtime / 'cli.js').write_text('// fixture\n')
        (runtime / 'notify.mjs').write_text('// fixture\n')
        (runtime / 'source.json').write_text(json.dumps({
            'dirty': False, 'source_commit': 'a' * 40, 'target': 'x86_64-unknown-linux-musl'}))
        staged = self.root / 'package'
        package.stage(source, runtime, staged, 'a' * 40)
        owned = {p.relative_to(staged) for p in staged.rglob('*') if not p.is_dir()}
        self.assertIn(Path('usr/share/harness-os/apple-t2/kernel.json'), owned)
        for identity in ('pc', 'apple-t2'):
            with self.subTest(identity=identity):
                folder = self.root / identity / 'profile'
                (folder / 'airootfs').mkdir(parents=True)
                (folder / 'packages.x86_64').write_text('linux-lts\nharness-os\n')
                with patch.object(profile, 'module', return_value=t2), patch.object(t2, 'LOCK', lock):
                    profile.configure(folder, identity, self.root)
                overlay = {p.relative_to(folder / 'airootfs') for p in (folder / 'airootfs').rglob('*') if not p.is_dir()}
                self.assertEqual(owned & overlay, set(), 'Live files must not preempt package-owned files')

    def test_corruption_fails_before_archive_tool_runs(self):
        self.package.write_bytes(b'truncated')
        with self.assertRaisesRegex(ValueError, 'pinned artifact'):
            t2.inspect(self.package, self.lock)

    def test_another_architecture_kernel_or_missing_input_cannot_pass(self):
        originals = dict(self.files)
        for change in ('architecture', 'kernel', 'missing-input', 'duplicate-input'):
            self.files = dict(originals)
            if change == 'architecture':
                self.files['.PKGINFO'] = self.files['.PKGINFO'].replace(b'x86_64', b'aarch64')
            elif change == 'kernel':
                self.files['usr/lib/modules/other/vmlinuz'] = bytes(0x202) + b'HdrS'
            elif change == 'missing-input':
                self.files.pop('usr/lib/modules/7.2.8-test-t2/kernel/t2bce_vhci.ko.zst')
            else:
                self.files['usr/lib/modules/7.2.8-test-t2/extra/t2bce_vhci.ko.zst'] = b'duplicate'
            self.write_package()
            with self.subTest(change=change), self.assertRaises(ValueError):
                t2.inspect(self.package, self.lock)

    def test_archive_traversal_and_duplicate_paths_are_rejected(self):
        for name in ('../escape', '/absolute', '.PKGINFO'):
            self.write_package(tarfile.TarInfo(name))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Unsafe or duplicate'):
                t2.inspect(self.package, self.lock)


if __name__ == '__main__':
    unittest.main()
