from contextlib import contextmanager
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from test_t2_firmware import firmware, source_fixture


spec = importlib.util.spec_from_file_location('t2_install', Path(__file__).parents[1] / 't2_install.py')
t2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t2)


class FirmwarePreservation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.model = 'MacBookAir9,1'
        self.source = self.root / 'firmware'
        source_fixture(self.source)
        self.bundle = self.root / 'harness-apple-firmware.tar'
        self.manifest = firmware.prepare(self.source, self.bundle, self.model)
        self.work = self.root / 'work'
        self.work.mkdir()

    def test_export_is_copied_to_ram_verified_restored_and_recoverable(self):
        with patch.object(t2, 'find_bundle', return_value=self.bundle):
            with t2.preserve('/dev/vda', self.model, runtime=self.work) as preserved:
                self.assertTrue(preserved['bundle'].is_relative_to(self.work))
                target = self.root / 'installed'
                target.mkdir()
                receipt = t2.restore(target, preserved)
                (target / 'var/lib/harness-os/install.json').write_text(json.dumps({'apple_firmware': receipt}))
                retained = t2.retained(target)
                self.assertEqual(retained['manifest'], self.manifest)
                _, files = firmware.verify(self.bundle, self.model)
                self.assertEqual({p.name: p.read_bytes() for p in (target / 'usr/lib/firmware/brcm').iterdir()}, files)
                # Simulate a package replacing board data with a fallback link.
                sentinel = self.root / 'outside'
                sentinel.write_bytes(b'untouched')
                name = next(iter(files))
                changed = target / 'usr/lib/firmware/brcm' / name
                changed.unlink()
                changed.symlink_to(sentinel)
                t2.restore(target, retained)
                self.assertEqual(changed.read_bytes(), files[name])
                self.assertFalse(changed.is_symlink())
                self.assertEqual(sentinel.read_bytes(), b'untouched')
                self.assertEqual(receipt, t2.restore(target, retained))
                retained['bundle'].write_bytes(b'changed')
                with self.assertRaises(ValueError):
                    t2.retained(target)
            self.assertEqual(list(self.work.iterdir()), [])

    def test_missing_and_wrong_machine_exports_do_not_yield_installation_input(self):
        with patch.object(t2, 'partitions', return_value=[]), self.assertRaisesRegex(ValueError, 'No disk has been erased'):
            t2.find_bundle('/dev/vda', self.work, self.model, exports=[])
        with self.assertRaises(ValueError):
            t2.find_bundle('/dev/vda', self.work, 'MacBookPro16,1', exports=[self.bundle])

    def test_failed_install_retains_verified_ram_export_for_recovery(self):
        with patch.object(t2, 'find_bundle', return_value=self.bundle), self.assertRaisesRegex(ValueError, 'failed installation'):
            with t2.preserve('/dev/vda', self.model, runtime=self.work) as preserved:
                saved = preserved['bundle']
                raise ValueError('failed installation')
        self.assertEqual(firmware.verify(saved, self.model)[0], self.manifest)

    def test_efi_export_is_preserved_before_unmount_and_source_disappearance(self):
        calls = []
        @contextmanager
        def mount(device, kind, folder, volume):
            calls.append(('mount', device, kind, volume))
            shutil.copyfile(self.bundle, folder / self.bundle.name)
            try:
                yield folder
            finally:
                (folder / self.bundle.name).unlink()
                calls.append(('unmount',))
        with patch.object(t2, 'partitions', return_value=[('/dev/vda1', 'vfat')]), patch.object(t2, 'mounted', mount):
            saved = t2.find_bundle('/dev/vda', self.work, self.model, exports=[])
        self.assertEqual(calls, [('mount', '/dev/vda1', 'vfat', None), ('unmount',)])
        self.assertEqual(firmware.verify(saved, self.model)[0], self.manifest)

    def test_apfs_mounts_are_read_only_and_unmount_failure_stops_preservation(self):
        with patch.object(t2, 'run') as run:
            with t2.mounted('/dev/vda2', 'apfs', self.work, 2):
                pass
            self.assertEqual(run.call_args_list[0].args[:6], ('mount', '-t', 'apfs', '-o', 'ro,nosuid,nodev,noexec,vol=2', '/dev/vda2'))
            self.assertEqual(run.call_args_list[1].args, ('umount', self.work))
        @contextmanager
        def stuck(device, kind, folder, volume):
            shutil.copyfile(self.bundle, folder / self.bundle.name)
            yield folder
            raise subprocess.CalledProcessError(1, ['umount'])
        with patch.object(t2, 'partitions', return_value=[('/dev/vda1', 'vfat')]), patch.object(t2, 'mounted', stuck):
            with self.assertRaises(subprocess.CalledProcessError):
                t2.find_bundle('/dev/vda', self.work, self.model, exports=[])

    def test_apfs_volume_probe_converts_only_found_system_firmware(self):
        seen = []
        @contextmanager
        def mounted(device, kind, folder, volume):
            seen.append(volume)
            if volume != 2:
                raise subprocess.CalledProcessError(1, ['mount'])
            shutil.copytree(self.source, folder / 'usr/share/firmware')
            yield folder
        with patch.object(t2, 'partitions', return_value=[('/dev/vda2', 'apfs')]), patch.object(t2, 'mounted', mounted):
            saved = t2.find_bundle('/dev/vda', self.work, self.model, exports=[])
        self.assertEqual(seen, [0, 1, 2])
        self.assertEqual(firmware.verify(saved, self.model)[0], self.manifest)

    def test_wrong_disk_identity_and_partition_paths_are_refused(self):
        def output(devices):
            return subprocess.CompletedProcess([], 0, json.dumps({'blockdevices': devices}))
        for device in [
            {'name': '/dev/vdb', 'type': 'disk'},
            {'name': '/dev/vda', 'type': 'part'},
            {'name': '/dev/vda', 'type': 'disk', 'children': [{'name': '/dev/../etc', 'type': 'part', 'fstype': 'vfat'}]},
        ]:
            with patch.object(t2, 'run', return_value=output([device])), self.assertRaises(ValueError):
                t2.partitions('/dev/vda')


if __name__ == '__main__':
    unittest.main()
