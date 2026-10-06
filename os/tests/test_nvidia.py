import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ROOT = Path(__file__).resolve().parents[1]
hardware = load('nvidia_hardware', ROOT / 'hardware.py')
builder = load('nvidia_builder', ROOT / 'tools/build-nvidia.py')


class NvidiaSelection(unittest.TestCase):
    def card(self, identity='10de:2684', driver='nouveau', kind='030000'):
        return {'id': identity, 'driver': driver, 'class': kind}

    def test_match_supported_display_and_compute_devices_without_pci_ranges(self):
        supported = {'10de:2684': ['RTX 4090'], '10de:2b85': ['RTX 5090']}
        self.assertEqual(hardware.nvidia_selection([self.card(), self.card('10de:2b85', None, '030200')], supported),
                         {'status': 'selected', 'devices': ['10de:2684', '10de:2b85']})
        for devices in [[], [self.card('8086:1234')], [self.card(kind='040300')]]:
            self.assertIsNone(hardware.nvidia_selection(devices, supported))
        self.assertEqual(hardware.nvidia_selection([self.card('10de:ffff')], supported)['status'], 'unchanged')

    def test_legacy_second_gpu_and_passthrough_are_preserved(self):
        supported = {'10de:2684': ['RTX 4090']}
        for devices in [[self.card(), self.card('10de:1b80')], [self.card(driver='vfio-pci')],
                        [self.card(driver='another-driver')]]:
            self.assertEqual(hardware.nvidia_selection(devices, supported)['status'], 'unchanged')

    def test_running_root_cannot_be_used_as_an_installation(self):
        with patch.object(hardware, 'run') as run, self.assertRaises(ValueError):
            hardware.configure_nvidia_install(Path('/'), [self.card()])
        run.assert_not_called()

    def test_generic_target_does_not_read_or_install_optional_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / 'etc').mkdir()
            (target / 'etc/harness-live').touch()
            with patch.object(hardware.Path, 'is_mount', return_value=True), \
                    patch.object(hardware, 'run') as run, patch.object(hardware, 'nvidia_bundle_manifest') as read:
                self.assertIsNone(hardware.configure_nvidia_install(target, [], target / 'absent'))
            run.assert_not_called()
            read.assert_not_called()

    def test_bundle_hashes_and_symlink_confinement(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / 'bundle'
            folder.mkdir()
            outside = Path(temp) / 'outside'
            outside.write_bytes(b'driver')
            (folder / 'driver').symlink_to(outside)
            manifest = {'schema': 1, 'driver': 'nvidia-open', 'architecture': 'x86_64',
                        'driver_version': '615.71.09', 'supported_devices': {'10de:2684': ['RTX 4090']},
                        'files': {'driver': {'bytes': 6, 'sha256': hardware.digest(outside)}}}
            (folder / 'manifest.json').write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'inside'):
                hardware.nvidia_bundle_manifest(folder, all_files=True)
            (folder / 'driver').unlink()
            (folder / 'driver').write_bytes(b'corrupted')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                hardware.nvidia_bundle_manifest(folder, all_files=True)


class NvidiaOwnership(unittest.TestCase):
    supported = {'10de:2684': ['RTX 4090']}
    reserved = [(None, 'vfio-pci'), (None, 'pci-stub'), (None, 'none'),
                (None, 'nouveau'), ('nouveau', 'nouveau'), ('nvidia', 'vfio-pci')]

    def discover(self, root, assignments):
        sysfs = root / 'sys'
        for index, (driver, override) in enumerate(assignments):
            device = sysfs / 'bus/pci/devices' / f'0000:{index + 3:02x}:00.0'
            device.mkdir(parents=True)
            for name, value in [('vendor', '0x10de'), ('device', '0x2684'),
                                ('class', '0x030000'), ('driver_override', override)]:
                (device / name).write_text(value + '\n')
            if driver:
                binding = sysfs / 'bus/pci/drivers' / driver
                binding.mkdir(parents=True, exist_ok=True)
                (device / 'driver').symlink_to(binding)
        return hardware.pci_devices(sysfs)

    def test_explicit_assignment_preserves_single_and_mixed_gpu_sets(self):
        automatic = ('nouveau', '(null)')
        for reserved in self.reserved:
            for assignments in [[reserved], [automatic, reserved], [reserved, automatic]]:
                with self.subTest(assignments=assignments), tempfile.TemporaryDirectory() as temp:
                    devices = self.discover(Path(temp), assignments)
                    self.assertEqual(len(devices), len(assignments))
                    self.assertEqual(hardware.nvidia_selection(devices, self.supported)['status'], 'unchanged')

    def test_default_and_explicit_nvidia_bindings_remain_eligible(self):
        assignments = [(None, '(null)'), (None, ''), ('nouveau', '(null)'),
                       ('nouveau', ''), ('nvidia', '(null)'), (None, 'nvidia'),
                       ('nouveau', 'nvidia'), ('nvidia', 'nvidia')]
        with tempfile.TemporaryDirectory() as temp:
            devices = self.discover(Path(temp), assignments)
            self.assertEqual([device['driver_override'] for device in devices],
                             [None, None, None, None, None, 'nvidia', 'nvidia', 'nvidia'])
            self.assertEqual(hardware.nvidia_selection(devices, self.supported),
                             {'status': 'selected', 'devices': ['10de:2684'] * len(assignments)})

    def test_reserved_gpu_install_does_not_run_commands_or_change_target(self):
        for reserved in self.reserved:
            for existing_config in [False, True]:
                with self.subTest(reserved=reserved, existing_config=existing_config), \
                        tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    devices = self.discover(root, [('nouveau', '(null)'), reserved])
                    target, bundle = root / 'target', root / 'bundle'
                    (target / 'etc/mkinitcpio.conf.d').mkdir(parents=True)
                    (target / 'etc/harness-live').touch()
                    if existing_config:
                        (target / 'etc/mkinitcpio.conf.d/30-harness-nvidia.conf').write_text('# Keep my GPU setup.\n')
                    (target / 'usr/share/harness-os').mkdir(parents=True)
                    (target / 'usr/share/harness-os/lock.json').write_text(json.dumps({'arch_snapshot': '2026/10/01'}))
                    bundle.mkdir()
                    (bundle / 'manifest.json').write_text(json.dumps({
                        'schema': 1, 'driver': 'nvidia-open', 'architecture': 'x86_64',
                        'driver_version': '615.71.09', 'supported_devices': self.supported,
                        'arch_snapshot': '2026/10/01', 'base_packages': {'linux-lts': '6.18.54-1'}, 'files': {}}))
                    before = {str(path.relative_to(target)): path.read_bytes() if path.is_file() else None
                              for path in target.rglob('*')}
                    with patch.object(hardware.Path, 'is_mount', return_value=True), \
                            patch.object(hardware, 'run', side_effect=AssertionError('A reserved GPU started privileged setup')) as run:
                        result = hardware.configure_nvidia_install(target, devices, bundle)
                    self.assertEqual(result['status'], 'unchanged')
                    run.assert_not_called()
                    self.assertEqual({str(path.relative_to(target)): path.read_bytes() if path.is_file() else None
                                      for path in target.rglob('*')}, before)


class NvidiaSupportTable(unittest.TestCase):
    def test_current_table_only_with_subsystem_rows(self):
        contents = '''<table><tr><td>Navigation</td></tr></table>
<a id="Current"></a><table><thead><tr><th>Product</th></tr></thead><tbody>
<tr><td>NVIDIA RTX &amp; fixture</td><td>2684</td><td>K</td></tr>
<tr><td>OEM fixture</td><td>2684 1028 0001</td><td>K</td></tr>
</tbody></table><a id="legacy"></a><table><tr><td>GTX 1080</td><td>1B80</td></tr></table>'''
        self.assertEqual(builder.supported_devices(contents, '615.71.09'),
                         {'10de:2684': ['NVIDIA RTX & fixture', 'OEM fixture']})

    def test_older_release_missing_current_marker_and_invalid_ids_fail(self):
        for contents, version in [('<a id="Current"></a><table></table>', '615.71.09'),
                                  ('<table><tr><td>Old</td><td>2684</td></tr></table>', '615.71.09'),
                                  ('<a id="Current"></a><table><tr><td>Bad</td><td>bad-id</td></tr></table>', '615.71.09'),
                                  ('anything', '580.1.1')]:
            with self.subTest(contents=contents, version=version), self.assertRaises(ValueError):
                builder.supported_devices(contents, version)


if __name__ == '__main__':
    unittest.main()
