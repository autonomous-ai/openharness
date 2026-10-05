import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

from payload_compression import compare, extract, inventory, measured, package_sizes, tool_versions


class PackageSizes(unittest.TestCase):
    def test_installed_database_sizes_are_ranked_without_sync_database_fields(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, size in [('small', 31), ('largest', 901), ('middle', 210)]:
                desc = root / 'var/lib/pacman/local' / (name + '-1.0-1') / 'desc'
                desc.parent.mkdir(parents=True)
                desc.write_text(f'%NAME%\n{name}\n\n%VERSION%\n1.0-1\n\n%SIZE%\n{size}\n\n%REASON%\n0\n')
            self.assertEqual(package_sizes(root), [
                {'name': 'largest', 'bytes': 901}, {'name': 'middle', 'bytes': 210}, {'name': 'small', 'bytes': 31}])

    def test_missing_size_is_explicitly_unknown_and_does_not_stop_the_assessment(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            desc = root / 'var/lib/pacman/local/metadata-only-1/desc'
            desc.parent.mkdir(parents=True)
            desc.write_text('%NAME%\nmetadata-only\n\n%VERSION%\n1\n')
            row, = package_sizes(root)
            self.assertIsNone(row['bytes'])
            self.assertEqual(row['size_status'], 'not recorded')
            self.assertEqual(row['database_fields'], ['%NAME%', '%VERSION%'])


class Fixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'source'
        self.root.mkdir()
        self.file = self.root / 'executable'
        self.file.write_bytes(b'original')
        self.file.chmod(0o755)
        os.link(self.file, self.root / 'hardlink')
        (self.root / 'symlink').symlink_to('executable')


@unittest.skipUnless(platform.system() == 'Linux', 'Linux filesystem extended attribute API')
class InventoryTest(Fixture, unittest.TestCase):
    def test_inventory_is_stable_and_does_not_follow_symlinks(self):
        (self.base / 'outside').mkdir()
        (self.base / 'outside' / 'secret').write_text('outside the image')
        (self.root / 'outside').symlink_to(self.base / 'outside', target_is_directory=True)
        first = inventory(self.root)
        self.assertIsNone(compare(first, inventory(self.root)))
        self.assertNotIn('outside/secret', first['entries'])
        self.assertEqual([['executable', 'hardlink']], first['hardlinks'])

    def test_same_length_corruption_is_detected(self):
        first = inventory(self.root)
        info = self.file.stat()
        self.file.write_bytes(b'corrupt!')
        os.utime(self.file, ns=(info.st_atime_ns, info.st_mtime_ns))
        self.assertIn('executable', compare(first, inventory(self.root))['changed_paths'])

    def test_permissions_and_symlink_targets_are_detected(self):
        first = inventory(self.root)
        self.file.chmod(0o644)
        link = self.root / 'symlink'
        link.unlink()
        link.symlink_to('elsewhere')
        changed = compare(first, inventory(self.root))['changed_paths']
        self.assertIn('executable', changed)
        self.assertIn('symlink', changed)

    def test_broken_hardlink_is_detected_with_identical_file_contents(self):
        first = inventory(self.root)
        link = self.root / 'hardlink'
        link.unlink()
        shutil.copy2(self.file, link)
        self.assertTrue(compare(first, inventory(self.root))['hardlinks_changed'])

    @unittest.skipUnless(platform.system() == 'Linux', 'Linux extended attribute semantics')
    def test_xattr_change_is_detected(self):
        os.setxattr(self.file, 'user.harness-test', b'original')
        first = inventory(self.root)
        os.setxattr(self.file, 'user.harness-test', b'changed')
        self.assertIn('executable', compare(first, inventory(self.root))['changed_paths'])


@unittest.skipUnless(platform.system() == 'Linux', 'Needs Linux SquashFS and GNU time')
class NativeTest(Fixture, unittest.TestCase):
    @unittest.skipUnless(all(shutil.which(tool) for tool in ['mksquashfs', 'unsquashfs', 'xorriso']),
                         'Needs the assessment toolchain')
    def test_version_reporting_accepts_tools_without_an_input_image(self):
        versions = tool_versions()
        self.assertEqual(set(versions), {'mksquashfs', 'unsquashfs', 'xorriso'})
        self.assertTrue(all(row['output'] for row in versions.values()))

    @unittest.skipUnless(os.geteuid() == 0 and all(shutil.which(tool) for tool in ['mksquashfs', 'unsquashfs', 'setcap']),
                         'SquashFS metadata roundtrip needs root, squashfs-tools and libcap2-bin')
    def test_roundtrip_preserves_privileged_metadata(self):
        self.assertEqual(os.geteuid(), 0, 'Run the native fixture tests as root')
        self.assertTrue(shutil.which('setcap'), 'Install libcap2-bin for capability preservation checks')
        os.chown(self.root / 'hardlink', 1000, 1000)
        self.file.chmod(0o4755)
        subprocess.run(['setcap', 'cap_net_bind_service=ep', str(self.file)], check=True)
        os.setxattr(self.file, 'user.harness-test', b'preserve me')
        os.mkfifo(self.root / 'fifo', 0o640)
        os.mknod(self.root / 'device', stat.S_IFCHR | 0o600, os.makedev(1, 3))
        expected = inventory(self.root)
        image = self.base / 'fixture.sfs'
        measured(['mksquashfs', self.root, image, '-noappend', '-no-progress', '-comp', 'zstd',
                  '-Xcompression-level', '15', '-b', '1M', '-processors', '2', '-mem', '64M'],
                 self.base, 'compress-fixture', timeout=30)
        extract(image, self.base / 'extracted', self.base, 'extract-fixture')
        self.assertIsNone(compare(expected, inventory(self.base / 'extracted')))

    def test_failed_command_is_not_a_measurement(self):
        with self.assertRaisesRegex(RuntimeError, 'exited 7'):
            measured([sys.executable, '-c', 'raise SystemExit(7)'], self.base, 'failed', timeout=5)

    def test_timeout_stops_descendants(self):
        marker = self.base / 'should-not-exist'
        child = 'import time,pathlib; time.sleep(.6); pathlib.Path(' + repr(str(marker)) + ').touch()'
        parent = ('import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",'
                  + repr(child) + ']); time.sleep(20)')
        with self.assertRaises(subprocess.TimeoutExpired):
            measured([sys.executable, '-c', parent], self.base, 'timeout', timeout=.2)
        time.sleep(.7)
        self.assertFalse(marker.exists(), 'Timed-out command left a descendant running')


if __name__ == '__main__':
    unittest.main()
