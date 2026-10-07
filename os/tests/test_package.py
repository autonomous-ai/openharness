import importlib.util
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('os_package', Path(__file__).parents[1] / 'tools/build-package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageIdentity(unittest.TestCase):
    def test_new_accounts_discover_the_packaged_guide_without_model_overrides(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            runtime = base / 'runtime'
            runtime.mkdir()
            for name in ['harness-tui', 'cli.js', 'notify.mjs']:
                (runtime / name).write_bytes(b'runtime fixture')
            destination = base / 'stage'
            with patch.object(package, 'validate_runtime', return_value={'source_commit': 'a' * 40}):
                identity = package.stage(Path(__file__).resolve().parents[2], runtime, destination, 'a' * 40)
            config = destination / 'etc/skel/.config/opencode'
            self.assertFalse((config / 'AGENTS.md').is_symlink())
            self.assertIn('/usr/share/harness-os/guide.md', (config / 'AGENTS.md').read_text())
            self.assertIn('Super+n', (destination / 'usr/share/harness-os/guide.md').read_text())
            settings = json.loads((config / 'opencode.json').read_text())
            self.assertEqual(settings['update'], 'disable')
            # One free Zen model that answers with tools (upstream's Exo Free default fails every
            # tool call with "Endpoint is unavailable"); providers and instructions stay upstream's.
            self.assertEqual(settings['model'], 'opencode/muse-spark-1.3-contributor-free')
            self.assertFalse(set(settings) & {'provider', 'providers', 'instructions'})
            self.assertEqual(settings['permissions'], [
                {'action': 'external_directory', 'resource': '/usr/share/harness-os/*', 'effect': 'allow'},
                {'action': 'read', 'resource': '/usr/share/harness-os/*', 'effect': 'allow'},
                {'action': 'edit', 'resource': '/usr/share/harness-os/*', 'effect': 'deny'},
            ], 'Only the packaged reference directory gets a read exception, never arbitrary filesystem access')
            # Validate the real staged package with the same guard that protects
            # installed systems, not only an isolated archive fixture.
            output = base / 'harness-os.pkg.tar.gz'
            package.archive_package(destination, output, package.package_info('1-1', 123456, 1024), 123456)
            with tarfile.open(output) as archive:
                metadata = archive.extractfile('.PKGINFO').read().decode().splitlines()
            depends = {row.removeprefix('depend = ') for row in metadata if row.startswith('depend = ')}
            self.assertTrue({'gtklock', 'grim', 'slurp', 'foot', 'tmux', 'nodejs-lts-jod'} <= depends)
            self.assertNotIn('labwc', depends)
            self.assertTrue(depends <= set((Path(__file__).parents[1] / 'packages.x86_64').read_text().split()))
            spec = importlib.util.spec_from_file_location('runtime_package_check', Path(__file__).parents[1] / 'runtime_update.py')
            updater = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(updater)
            updater.inspect_package(output, '1-1', identity)

    def test_same_source_is_byte_identical_across_build_times_and_output_names(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'stage'
            root.mkdir()
            (root / 'contents').write_bytes(b'unchanged source\n')
            artifacts = []
            for name, clock in [('first.pkg.tar.gz', 1234567), ('second.pkg.tar.gz', 9876543)]:
                output = Path(temp) / name
                with patch('time.time', return_value=clock):
                    package.archive_package(root, output, 'pkgname = fixture\npkgver = 1-1\n', 123456)
                artifacts.append(output.read_bytes())
            self.assertEqual(artifacts[0], artifacts[1])

    def test_macos_wrong_architecture_dirty_or_different_source_cannot_be_packaged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            good = {'source_commit': 'a' * 40, 'dirty': False, 'target': 'x86_64-unknown-linux-musl'}
            header = bytearray(20)
            header[:6] = b'\x7fELF\x02\x01'
            header[18:20] = (62).to_bytes(2, 'little')
            (root / 'harness-tui').write_bytes(header)
            for name in ['cli.js', 'notify.mjs']:
                (root / name).write_text('runtime fixture')
            (root / 'source.json').write_text(json.dumps(good))
            self.assertEqual(package.validate_runtime(root, 'a' * 40), good)
            for changes in [{'dirty': True}, {'source_commit': 'b' * 40}, {'target': 'aarch64-apple-darwin'},
                            {'target': 'aarch64-unknown-linux-musl', 'architecture': 'aarch64'}]:
                (root / 'source.json').write_text(json.dumps(dict(good, **changes)))
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    package.validate_runtime(root, 'a' * 40)
            (root / 'source.json').write_text(json.dumps(good))
            for bad_header in [b'\xcf\xfa\xed\xfe', header[:18] + (183).to_bytes(2, 'little')]:
                (root / 'harness-tui').write_bytes(bad_header)
                with self.assertRaises(ValueError):
                    package.validate_runtime(root, 'a' * 40)

    def test_archive_preserves_executable_and_symlink_with_root_ownership(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'stage'
            binary = root / 'usr/lib/harness/harness-tui'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'executable fixture')
            binary.chmod(0o755)
            (binary.parent / 'hn').symlink_to('harness-tui')
            output = Path(temp) / 'harness-os.pkg.tar.gz'
            package.archive_package(root, output, 'pkgname = harness-os\npkgver = 1-1\n', 123456)
            with tarfile.open(output) as archive:
                executable = archive.getmember('usr/lib/harness/harness-tui')
                self.assertEqual(executable.mode, 0o755)
                self.assertEqual(archive.extractfile(executable).read(), b'executable fixture')
                link = archive.getmember('usr/lib/harness/hn')
                self.assertTrue(link.issym())
                self.assertEqual(link.linkname, 'harness-tui')
                for member in archive.getmembers():
                    self.assertEqual((member.uid, member.gid, member.mtime), (0, 0, 123456))
                self.assertIn(b'pkgname = harness-os', archive.extractfile('.PKGINFO').read())
            self.assertFalse(output.with_name(output.name + '.partial').exists())


if __name__ == '__main__':
    unittest.main()
