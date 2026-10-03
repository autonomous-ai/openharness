import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('hardware', Path(__file__).resolve().parents[1] / 'hardware.py')
hardware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardware)


class HardwarePolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sysfs = self.root / 'sys'

    def device(self, address='0000:03:00.0', device='43a0', driver=None, wireless=False, kind='028000'):
        path = self.sysfs / 'bus/pci/devices' / address
        path.mkdir(parents=True)
        for name, value in [('vendor', '14e4'), ('device', device), ('class', kind)]:
            (path / name).write_text('0x' + value)
        (path / 'driver_override').write_text('(null)\n')
        if driver:
            bound = self.sysfs / 'bus/pci/drivers' / driver
            bound.mkdir(parents=True, exist_ok=True)
            (bound / 'unbind').touch()
            (path / 'driver').symlink_to(bound)
        if wireless:
            interface = self.sysfs / 'class/net' / ('wlan' + str(len(list((self.sysfs / 'class/net').glob('*')))))
            interface.mkdir(parents=True)
            child = path / 'bcma0:1'
            child.mkdir()
            (interface / 'device').symlink_to(child)
            (interface / 'wireless').mkdir()
        return path

    def bundle(self, folder=None):
        folder = folder or self.root / 'bundle'
        folder.mkdir(parents=True)
        module = folder / 'wl.ko'
        module.write_bytes(b'kernel-module-fixture')
        manifest = {'schema': 1, 'driver': 'broadcom-wl', 'architecture': 'x86_64',
                    'kernel': hardware.os.uname().release, 'module': 'wl.ko',
                    'arch_snapshot': '2026/10/01', 'base_packages': {'linux-lts': '6.18.54-1'},
                    'files': {'wl.ko': {'bytes': module.stat().st_size, 'sha256': hardware.digest(module)}}}
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        return folder

    def test_native_fullmac_and_working_b43_are_preserved(self):
        self.device(device='43ba', driver='brcmfmac', wireless=True)
        self.device(address='0000:04:00.0', device='4331', driver='bcma-pci-bridge', wireless=True)
        with patch.object(hardware, 'run') as run:
            for device in hardware.pci_devices(self.sysfs):
                self.assertFalse(hardware.needs_broadcom(device))
                self.assertEqual(hardware.activate(device['address'], self.sysfs)['status'], 'unchanged')
            run.assert_not_called()

    def test_only_selected_radio_ids_request_the_driver(self):
        self.device()
        self.device(address='0000:04:00.0', device='4331', driver='wl', wireless=True)
        self.device(address='0000:05:00.0', device='43bb')
        self.device(address='0000:06:00.0', device='43a0', kind='020000')
        self.assertEqual([d['address'] for d in hardware.pci_devices(self.sysfs) if hardware.needs_broadcom(d)],
                         ['0000:03:00.0', '0000:04:00.0'])

    def test_damaged_module_is_rejected_before_unbinding(self):
        device = self.device(driver='bcma-pci-bridge')
        bundle = self.bundle()
        (bundle / 'wl.ko').write_bytes(b'damaged')
        with patch.object(hardware, 'run') as run, self.assertRaisesRegex(ValueError, 'checksum'):
            hardware.activate(device.name, self.sysfs, bundle)
        run.assert_not_called()
        self.assertEqual((device / 'driver_override').read_text(), '(null)\n')
        self.assertEqual((device / 'driver/unbind').read_text(), '')

    def test_failed_load_restores_driver_selection(self):
        device = self.device(driver='bcma-pci-bridge')
        bundle = self.bundle()
        probe = self.sysfs / 'bus/pci/drivers_probe'
        probe.touch()

        def operation(*args, **kwargs):
            if args == ('modprobe', 'cfg80211'):
                # Simulate the preceding sysfs unbind's kernel side effect.
                (device / 'driver').unlink()
            else:
                raise subprocess.CalledProcessError(1, args)

        with patch.object(hardware, 'run', side_effect=operation), self.assertRaises(subprocess.CalledProcessError):
            hardware.activate(device.name, self.sysfs, bundle)
        self.assertEqual((device / 'driver_override').read_text(), '\n')
        self.assertEqual(probe.read_text(), device.name + '\n')

    def test_manifest_cannot_point_outside_bundle(self):
        bundle = self.bundle()
        (bundle / 'wl.ko').unlink()
        outside = self.root / 'external'
        outside.write_bytes(b'kernel-module-fixture')
        (bundle / 'wl.ko').symlink_to(outside)
        with self.assertRaisesRegex(ValueError, 'inside'):
            hardware.bundle_manifest(bundle)

    def test_running_root_and_unmounted_directory_cannot_receive_offline_packages(self):
        for target in [Path('/'), self.root]:
            with self.subTest(target=target), patch.object(hardware, 'run') as run, self.assertRaises(ValueError):
                hardware.configure_install(target, [])
            run.assert_not_called()

    def test_unrelated_install_prunes_only_its_hardware_cache(self):
        target = self.root / 'target'
        (target / 'etc').mkdir(parents=True)
        (target / 'etc/harness-live').touch()
        folder = self.bundle(target / hardware.BUNDLE.relative_to('/'))
        keep = folder.parent / 'keep.txt'
        keep.write_text('another hardware profile')
        with patch.object(hardware.Path, 'is_mount', return_value=True), patch.object(hardware, 'run') as run:
            result = hardware.configure_install(target, [])
        self.assertEqual(result['drivers'], [])
        run.assert_not_called()
        self.assertFalse(folder.exists())
        self.assertTrue(keep.is_file())
        self.assertTrue((target / 'etc/harness-live').exists())

    def test_dependency_mismatch_stops_before_package_transaction(self):
        self.device()
        target = self.root / 'target'
        (target / 'etc').mkdir(parents=True)
        (target / 'etc/harness-live').touch()
        self.bundle(target / hardware.BUNDLE.relative_to('/'))
        (target / 'usr/share/harness-os/lock.json').write_text('{"arch_snapshot":"2026/10/01"}')
        with patch.object(hardware.Path, 'is_mount', return_value=True), \
                patch.object(hardware, 'run', return_value='linux-lts different') as run, \
                self.assertRaisesRegex(ValueError, 'dependencies'):
            hardware.configure_install(target, hardware.pci_devices(self.sysfs))
        self.assertEqual(run.call_count, 1)
        self.assertIn('-Q', run.call_args.args)

    def test_report_does_not_collect_serials_network_addresses_or_ssids(self):
        self.device()
        dmi = self.sysfs / 'class/dmi/id'
        dmi.mkdir(parents=True)
        (dmi / 'product_name').write_text('MacBookAir6,2')
        (dmi / 'product_serial').write_text('PRIVATE-SERIAL')
        proc = self.root / 'proc'
        proc.mkdir()
        (proc / 'cpuinfo').write_text('flags : ssse3 sse4_2 avx\nSerial : PRIVATE-CPU\n')
        report = hardware.report(self.sysfs, proc)
        self.assertTrue(report['opencode_cpu']['available'])
        self.assertEqual(report['computer']['model'], 'MacBookAir6,2')
        self.assertNotIn('PRIVATE', json.dumps(report))
        (proc / 'cpuinfo').write_text('flags : ssse3\n')
        self.assertFalse(hardware.report(self.sysfs, proc)['opencode_cpu']['available'])


if __name__ == '__main__':
    unittest.main()
