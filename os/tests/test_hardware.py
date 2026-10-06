import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('hardware', Path(__file__).resolve().parents[1] / 'hardware.py')
hardware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hardware)


class OpenCodeCpu(unittest.TestCase):
    def supported(self, content, architecture='x86_64'):
        with tempfile.TemporaryDirectory() as folder:
            proc = Path(folder)
            if content is not None:
                (proc / 'cpuinfo').write_text(content)
            with patch.object(hardware.os, 'uname', return_value=SimpleNamespace(machine=architecture)):
                return hardware.opencode_cpu_supported(proc)

    def test_core2_and_penryn_lack_the_bundled_requirement(self):
        for flags in ['sse sse2 pni ssse3', 'sse sse2 pni ssse3 sse4_1']:
            with self.subTest(flags=flags):
                self.assertIs(self.supported('flags : ' + flags + '\n'), False)

    def test_nehalem_needs_no_avx(self):
        self.assertIs(self.supported('flags : sse2 ssse3 sse4_1 sse4_2\n'), True)

    def test_missing_empty_or_non_x86_information_is_unknown(self):
        for content in [None, '', 'processor : 0\n', 'flags : \n', 'Features : fp asimd\n']:
            with self.subTest(content=content):
                self.assertIsNone(self.supported(content))
        for architecture in ['aarch64', 'armv7l', 'riscv64']:
            with self.subTest(architecture=architecture):
                self.assertIsNone(self.supported('flags : sse2\n', architecture))

    def test_all_reported_cpus_must_have_the_feature(self):
        self.assertIs(self.supported('flags : sse2 sse4_2\n\nflags : sse2\n'), False)
        self.assertIs(self.supported('flags : sse2 sse4_2\n\nflags : sse2 sse4_2\n'), True)
        self.assertIsNone(self.supported('flags : sse2 sse4_2\n\nflags : \n'))


class HardwarePolicy(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.sysfs = self.root / 'sys'

    def device(self, address='0000:03:00.0', device='43a0', driver=None, wireless=False, kind='028000', override='(null)', vendor='14e4'):
        path = self.sysfs / 'bus/pci/devices' / address
        path.mkdir(parents=True)
        for name, value in [('vendor', vendor), ('device', device), ('class', kind)]:
            (path / name).write_text('0x' + value)
        (path / 'driver_override').write_text(override + '\n')
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

    def test_t2_installation_blocker_uses_bce_device_even_without_known_dmi(self):
        self.device(vendor='106b', device='1801', kind='088000', driver='vfio-pci')
        expected = 'This Harness image does not support Apple T2 Macs yet.'
        self.assertEqual(hardware.installation_blocker(self.sysfs), expected)
        dmi = self.sysfs / 'class/dmi/id'
        dmi.mkdir(parents=True)
        (dmi / 'product_name').write_text('Unrecognized Apple model')
        self.assertEqual(hardware.report(self.sysfs, self.root / 'proc')['installation_blocker'], expected)

    def test_t2_installation_blocker_does_not_guess_from_missing_dmi_or_other_ids(self):
        self.assertIsNone(hardware.installation_blocker(self.sysfs))
        self.device(vendor='106b', device='1803', kind='040100')  # T2 audio is not the BCE selector.
        self.device(address='0000:04:00.0', vendor='14e4', device='1801')
        dmi = self.sysfs / 'class/dmi/id'
        dmi.mkdir(parents=True)
        (dmi / 'product_name').write_text('MacBookPro14,3')
        self.assertIsNone(hardware.installation_blocker(self.sysfs))
        self.assertIsNone(hardware.report(self.sysfs, self.root / 'proc')['installation_blocker'])

    def bundle(self, folder=None):
        folder = folder or self.root / 'bundle'
        folder.mkdir(parents=True)
        module = folder / 'wl.ko'
        module.write_bytes(b'kernel-module-fixture')
        (folder / 'packages').mkdir()
        package = folder / 'packages/broadcom-wl-dkms-1-1-any.pkg.tar.zst'
        package.write_bytes(b'package-fixture')
        signature = package.with_name(package.name + '.sig')
        signature.write_bytes(b'signature-fixture')
        manifest = {'schema': 1, 'driver': 'broadcom-wl', 'architecture': 'x86_64',
                    'kernel': hardware.os.uname().release, 'module': 'wl.ko',
                    'arch_snapshot': '2026/10/01', 'base_packages': {'linux-lts': '6.18.54-1'},
                    'packages': {package.name: {'name': 'broadcom-wl-dkms', 'version': '1-1'}},
                    'files': {str(path.relative_to(folder)): {'bytes': path.stat().st_size, 'sha256': hardware.digest(path)}
                              for path in [module, package, signature]}}
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

    def test_explicit_assignment_is_preserved_before_loading_or_unbinding(self):
        for index, (driver, override) in enumerate([
                ('vfio-pci', '(null)'), ('pci-stub', '(null)'),
                ('another-driver', '(null)'), (None, 'vfio-pci'),
                (None, 'none'), ('bcma-pci-bridge', 'bcma-pci-bridge'),
                ('wl', 'pci-stub')]):
            path = self.device(address=f'0000:{index + 3:02x}:00.0', driver=driver, override=override)
            with self.subTest(driver=driver, override=override), patch.object(hardware, 'run') as run:
                device = next(d for d in hardware.pci_devices(self.sysfs) if d['address'] == path.name)
                self.assertFalse(hardware.needs_broadcom(device))
                self.assertEqual(hardware.activate(path.name, self.sysfs)['status'], 'unchanged')
                run.assert_not_called()
                self.assertEqual((path / 'driver_override').read_text(), override + '\n')
                if driver:
                    self.assertEqual((path / 'driver/unbind').read_text(), '')

    def test_ordinary_and_wl_overrides_retain_offline_driver_selection(self):
        for index, override in enumerate(['(null)', '', 'wl']):
            self.device(address=f'0000:{index + 3:02x}:00.0', override=override)
        devices = hardware.pci_devices(self.sysfs)
        self.assertTrue(all(hardware.needs_broadcom(device) for device in devices))
        self.assertEqual([device['driver_override'] for device in devices], [None, None, 'wl'])

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

    def test_assigned_radio_does_not_install_optional_driver_or_compiler(self):
        self.device(driver='vfio-pci')
        self.device(address='0000:04:00.0', override='none')
        target = self.root / 'target'
        (target / 'etc').mkdir(parents=True)
        (target / 'etc/harness-live').touch()
        folder = self.bundle(target / hardware.BUNDLE.relative_to('/'))
        with patch.object(hardware.Path, 'is_mount', return_value=True), \
                patch.object(hardware, 'run') as run, patch.object(hardware, 'bundle_manifest') as manifest:
            result = hardware.configure_install(target, hardware.pci_devices(self.sysfs))
        self.assertEqual(result, {'drivers': [], 'devices': []})
        run.assert_not_called()
        manifest.assert_not_called()
        self.assertFalse(folder.exists())

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

    def installation(self, shared=True):
        import shutil
        target = self.root / 'target'
        (target / 'etc').mkdir(parents=True)
        (target / 'etc/harness-live').touch()
        (target / 'var/tmp').mkdir(parents=True)
        live = self.bundle()
        folder = target / hardware.BUNDLE.relative_to('/')
        shutil.copytree(live, folder)
        if shared:
            shutil.rmtree(folder / 'packages')
        (target / 'usr/share/harness-os/lock.json').write_text('{"arch_snapshot":"2026/10/01"}')
        self.device()
        return target, folder, live

    def test_shared_cache_requires_matching_manifest_and_verified_archives(self):
        target, folder, live = self.installation()
        manifest = live / 'manifest.json'
        original = manifest.read_text()
        changed = json.loads(original)
        changed['arch_snapshot'] = '2026/09/01'
        manifest.write_text(json.dumps(changed))
        with patch.object(hardware.Path, 'is_mount', return_value=True), patch.object(hardware, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'image differ'):
                hardware.configure_install(target, hardware.pci_devices(self.sysfs), live)
            run.assert_not_called()
            manifest.write_text(original)
            next((live / 'packages').glob('*.pkg.tar.zst')).write_bytes(b'damaged-package')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                hardware.configure_install(target, hardware.pci_devices(self.sysfs), live)
            run.assert_not_called()
        self.assertTrue(folder.exists())

    def test_read_only_package_mount_is_removed_after_failed_transaction(self):
        target, folder, live = self.installation()
        calls = []

        def operation(*args, **kwargs):
            calls.append(args)
            if '-Q' in args:
                return 'linux-lts 6.18.54-1'
            if '-U' in args:
                config = target / args[args.index('--config') + 1].lstrip('/')
                self.assertIn('LocalFileSigLevel = Required', config.read_text())
                self.assertNotIn('[core]', config.read_text())
                raise subprocess.CalledProcessError(1, args)

        with patch.object(hardware.Path, 'is_mount', return_value=True), \
                patch.object(hardware, 'run', side_effect=operation), self.assertRaises(subprocess.CalledProcessError):
            hardware.configure_install(target, hardware.pci_devices(self.sysfs), live)
        self.assertEqual(calls[1][:3], ('mount', '--bind', live / 'packages'))
        self.assertEqual(calls[2][:3], ('mount', '-o', 'remount,bind,ro'))
        self.assertEqual(calls[-1], ('umount', calls[1][3]))
        self.assertFalse(list((target / 'var/tmp').iterdir()))
        self.assertTrue(folder.exists())
        hardware.bundle_manifest(live, all_files=True)

    def test_copied_cache_remains_the_source_for_override_images(self):
        target, folder, live = self.installation(shared=False)
        calls = []

        def operation(*args, **kwargs):
            calls.append(args)
            return 'linux-lts 6.18.54-1' if '-Q' in args else ''

        with patch.object(hardware.Path, 'is_mount', return_value=True), patch.object(hardware, 'run', side_effect=operation):
            result = hardware.configure_install(target, hardware.pci_devices(self.sysfs), self.root / 'missing-live-cache')
        self.assertEqual(calls[1][:3], ('mount', '--bind', folder / 'packages'))
        self.assertEqual(result['drivers'], ['broadcom-wl-dkms'])
        self.assertFalse(folder.exists())
        hardware.bundle_manifest(live, all_files=True)

    def test_report_does_not_collect_serials_network_addresses_or_ssids(self):
        uname = hardware.os.uname()
        self.enterContext(patch.object(hardware.os, 'uname',
                                       return_value=SimpleNamespace(machine='x86_64', release=uname.release)))
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
