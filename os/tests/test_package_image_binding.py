import copy
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import package_image_binding as binding


class PackageImageBindingTests(unittest.TestCase):
    def test_version_identification_handles_unsquashfs_exit_convention_only(self):
        for tool, code, output, valid in [
                ('unsquashfs', 1, 'unsquashfs version 4.6.1 (2023/03/25)\n', True),
                ('unsquashfs', 0, 'unsquashfs version 4.7.2\n', True),
                ('unsquashfs', 1, 'unknown option\n', False),
                ('unsquashfs', 127, 'unsquashfs version 4.6.1\n', False),
                ('xorriso', 1, 'xorriso 1.5.6\n', False),
                ('xorriso', 0, 'xorriso 1.5.6\n', True)]:
            result = subprocess.CompletedProcess([tool, '-version'], code, output, '')
            with self.subTest(tool=tool, code=code, output=output), patch.object(binding.subprocess, 'run', return_value=result):
                if valid:
                    self.assertEqual(binding.tool_version(tool)['version_exit_code'], code)
                else:
                    with self.assertRaises(ValueError):
                        binding.tool_version(tool)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.version = '0.1.0pre15.r123.g1234567890-1'
        self.package = self.root / ('harness-os-' + self.version + '-x86_64.pkg.tar.gz')
        self.files = {'usr/lib/harness/harness-tui': b'actual runtime bytes',
                      'etc/sudoers.d/30-harness-updates': b'me ALL=(root) NOPASSWD: /usr/bin/harness upgrade\n'}
        self.write_archive()

    def write_archive(self, extra=()):
        with tarfile.open(self.package, 'w:gz') as archive:
            metadata = ('pkgname = harness-os\npkgver = ' + self.version + '\narch = x86_64\n').encode()
            for name, data in {'.PKGINFO': metadata, **self.files}.items():
                info = tarfile.TarInfo(name)
                info.mode = 0o440 if name.startswith('etc/') else 0o755
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            link = tarfile.TarInfo('usr/lib/harness/hn')
            link.type, link.linkname, link.mode = tarfile.SYMTYPE, 'harness-tui', 0o777
            archive.addfile(link)
            for entry in extra:
                archive.addfile(entry, io.BytesIO(b''))

    def listing(self):
        return binding.parse_listing('\n'.join([
            'drwxr-xr-x 0/0 42 2026-10-05 01:00 squashfs-root/usr',
            f'-rwxr-xr-x 0/0 {len(self.files["usr/lib/harness/harness-tui"])} 2026-10-05 01:00 squashfs-root/usr/lib/harness/harness-tui',
            f'-r--r----- 0/0 {len(self.files["etc/sudoers.d/30-harness-updates"])} 2026-10-05 01:00 squashfs-root/etc/sudoers.d/30-harness-updates',
            'lrwxrwxrwx 0/0 11 2026-10-05 01:00 squashfs-root/usr/lib/harness/hn -> harness-tui']))

    def test_real_archive_compares_every_file_and_link(self):
        rows = binding.archive_inventory(self.package, self.version)
        compared = binding.compare_members(rows, self.listing(), self.files.__getitem__)
        self.assertEqual({row['archive']['name'] for row in compared}, {*self.files, 'usr/lib/harness/hn'})
        self.assertTrue(all(row['equal'] for row in compared))
        binding.verify_owned_paths(rows, '%FILES%\nusr/\n' + '\n'.join(row['name'] for row in rows) + '\n\n')
        with self.assertRaisesRegex(ValueError, 'ownership list'):
            binding.verify_owned_paths(rows, '%FILES%\nusr/\nusr/lib/harness/harness-tui\n')

    def test_modified_missing_or_incorrectly_owned_iso_members_fail(self):
        rows = binding.archive_inventory(self.package, self.version)
        runtime = 'usr/lib/harness/harness-tui'
        for kind in ['bytes', 'missing', 'mode', 'owner', 'link']:
            with self.subTest(kind=kind):
                files, listing = dict(self.files), self.listing()
                if kind == 'bytes':
                    files[runtime] = b'changed runtime bytes'
                elif kind == 'missing':
                    listing.pop(runtime)
                elif kind == 'mode':
                    listing[runtime]['mode_string'] = '-rw-r--r--'
                elif kind == 'owner':
                    listing[runtime]['uid'] = 1000
                else:
                    listing['usr/lib/harness/hn']['target'] = 'other-binary'
                with self.assertRaises(ValueError):
                    binding.compare_members(rows, listing, files.__getitem__)

    def test_unsafe_duplicate_and_hardlinked_archive_entries_fail(self):
        entries = [tarfile.TarInfo('../escape'), tarfile.TarInfo('/absolute'),
                   tarfile.TarInfo('usr/lib/harness/harness-tui'), tarfile.TarInfo('usr/ambiguous -> name')]
        hardlink = tarfile.TarInfo('usr/hardlink')
        hardlink.type, hardlink.linkname = tarfile.LNKTYPE, 'usr/lib/harness/harness-tui'
        entries.append(hardlink)
        for entry in entries:
            with self.subTest(name=entry.name):
                self.write_archive([entry])
                with self.assertRaises(ValueError):
                    binding.archive_inventory(self.package, self.version)

    def test_manifests_bind_real_package_and_image_bytes(self):
        iso = self.root / 'candidate.iso'
        iso.write_bytes(b'private image fixture')
        runtime = {'source_commit': 'a' * 40, 'dirty': False, 'target': 'x86_64-unknown-linux-musl',
                   'files': {name: {'bytes': 1, 'sha256': hashlib.sha256(b'x').hexdigest()}
                             for name in ('harness-tui', 'cli.mjs', 'notify.mjs')}}
        manifest = {'schema': 1, 'kind': 'harness-os-package', 'source_commit': 'a' * 40,
                    'architecture': 'x86_64', 'requires_os_version': '0.1.0-preview.15',
                    'arch_snapshot': '2026/10/01', 'runtime': runtime,
                    'package': {'name': self.package.name, 'version': self.version, **binding.identity(self.package)}}
        image = {'source_commit': 'a' * 40, 'architecture': 'x86_64', 'version': '0.1.0-preview.15',
                 'arch_snapshot': '2026/10/01', 'package_version': self.version, 'harness_inputs': runtime,
                 'iso': {'name': iso.name, **binding.identity(iso)}}
        (self.root / 'manifest.json').write_text(json.dumps(image))
        (self.root / 'package-manifest.json').write_text(json.dumps(manifest))
        binding.validate_inputs(iso, self.root)
        for key in ('source_commit', 'runtime', 'package'):
            altered = copy.deepcopy(manifest)
            if key == 'source_commit':
                altered[key] = 'b' * 40
            elif key == 'runtime':
                altered[key]['dirty'] = True
            else:
                altered[key]['sha256'] = '0' * 64
            (self.root / 'package-manifest.json').write_text(json.dumps(altered))
            with self.subTest(key=key), self.assertRaises(ValueError):
                binding.validate_inputs(iso, self.root)
        (self.root / 'package-manifest.json').write_text(json.dumps(manifest))
        iso.write_bytes(b'changed image fixture')
        with self.assertRaisesRegex(ValueError, 'hash or size'):
            binding.validate_inputs(iso, self.root)

    @unittest.skipUnless(shutil.which('mksquashfs') and shutil.which('unsquashfs'), 'Native SquashFS tools required')
    def test_native_squashfs_listing_and_bytes(self):
        root = self.root / 'payload'
        for name, data in self.files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o440 if name.startswith('etc/') else 0o755)
        (root / 'usr/lib/harness/hn').symlink_to('harness-tui')
        payload = self.root / 'payload.sfs'
        subprocess.run(['mksquashfs', str(root), str(payload), '-all-root', '-noappend', '-no-progress', '-processors', '1'],
                       check=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15)
        listing = binding.parse_listing(subprocess.check_output(['unsquashfs', '-lln', str(payload)], text=True))
        rows = binding.archive_inventory(self.package, self.version)
        binding.compare_members(rows, listing, lambda name: subprocess.check_output(['unsquashfs', '-cat', str(payload), name]))


if __name__ == '__main__':
    unittest.main()
