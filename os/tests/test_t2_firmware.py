import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


TOOL = Path(__file__).parents[1] / 'tools/prepare-t2-firmware.py'
spec = importlib.util.spec_from_file_location('harness_t2_firmware', TOOL)
firmware = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firmware)


def source_fixture(root):
    """Invented sentinel bytes only; never distribute Apple's firmware in tests."""
    files = {}
    for folder in sorted(firmware.names.WIFI_FOLDERS):
        for ext in ('trx', 'clmb', 'txcb'):
            files['wifi/' + folder + '/fiji.' + ext] = (folder + ':' + ext + ':fixture\x00').encode()
        for vendor, value in [('m', b'1'), ('u', b'2')]:
            files['wifi/' + folder + '/P-fiji_M-SPPR_V-' + vendor + '__m-3.1.txt'] = b'boardrev =fixture\nvalue=' + value + b'\n'
    for vendor in ('MUR', 'USI'):
        for extension in ('bin', 'ptb'):
            files['bluetooth/BCM4377B3_PCIE_macOS_HawaiiES2_' + vendor + '.' + extension] = (vendor + ':' + extension + ':fixture').encode()
    # These must never get copied into a T2 bundle.
    files['bluetooth/BCM4378B1_PCIE_macOS_J314_MUR.bin'] = b'Apple Silicon fixture'
    files['bluetooth/BCM4377B3_PCIE_macOS_HawaiiES2_MUR_DEV.bin'] = b'development fixture'
    files['wifi/C-4378__s-B1/j314.trx'] = b'Apple Silicon fixture'
    for name, data in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    return files


class T2FirmwareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'macos-firmware'
        self.inputs = source_fixture(self.source)
        self.bundle = self.root / 'firmware.tar'
        self.model = 'MacBookAir9,1'

    def prepare(self, **kwargs):
        return firmware.prepare(self.source, self.bundle, kwargs.pop('model', self.model), **kwargs)

    def archive(self, entries):
        with tarfile.open(self.bundle, 'w', format=tarfile.USTAR_FORMAT) as output:
            for name, value in entries:
                if isinstance(name, tarfile.TarInfo):
                    entry = name
                else:
                    entry = tarfile.TarInfo(name)
                    entry.mode, entry.size = 0o644, len(value)
                output.addfile(entry, io.BytesIO(value))

    def entries(self):
        with tarfile.open(self.bundle) as archive:
            return [(entry.name, archive.extractfile(entry).read()) for entry in archive]

    def test_mac_export_linux_names_and_private_staging_preserve_exact_data(self):
        before = dict(self.inputs)
        manifest = self.prepare()
        verified, values = firmware.verify(self.bundle, self.model)
        self.assertEqual(verified, manifest)
        self.assertEqual(values['brcmfmac4377b3-pcie.apple,fiji.bin'], b'C-4377__s-B3:trx:fixture\x00')
        self.assertEqual(values['brcmfmac4377b3-pcie.apple,fiji-SPPR-m.txt'], b'boardrev=fixture\nvalue=1\n')
        self.assertEqual(values['brcmbt4377b3-apple,hawaii-m.ptb'], b'MUR:ptb:fixture')
        self.assertFalse(any('4378' in name or '_DEV' in name for name in values))
        output = self.root / 'staged'
        self.assertEqual(firmware.stage(self.bundle, output, self.model), manifest)
        self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o700)
        self.assertEqual({p.name: p.read_bytes() for p in (output / 'brcm').iterdir()}, values)
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode) == 0o644 and not p.is_symlink() for p in (output / 'brcm').iterdir()))
        self.assertEqual({name: (self.source / name).read_bytes() for name in before}, before)

    def test_archive_is_deterministic_and_never_overwrites_existing_output(self):
        self.prepare()
        first = self.bundle.read_bytes()
        self.bundle.unlink()
        with patch('time.time', return_value=9876543):
            self.prepare()
        self.assertEqual(self.bundle.read_bytes(), first)
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(self.bundle.read_bytes(), first)
        self.assertEqual(list(self.root.glob('.harness-firmware-*')), [])
        output = self.root / 'existing'
        output.mkdir()
        (output / 'work').write_bytes(b'preserve')
        with self.assertRaises(FileExistsError):
            firmware.stage(self.bundle, output, self.model)
        self.assertEqual((output / 'work').read_bytes(), b'preserve')

    def test_calibration_is_exported_for_the_exact_imac_pro(self):
        nvram = 'wifi/C-4364__s-B2/P-fiji_M-SPPR_V-m__m-3.1.txt'
        txcap = 'wifi/C-4364__s-B2/fiji.txcb'
        requested = plistlib.dumps([{'IORegistryEntryChildren': [{'RequestedFiles': {
            'NVRAM': '/usr/share/firmware/' + nvram, 'TxCap': '/' + txcap}}]}])
        self.prepare(model='iMacPro1,1', requested_files=requested)
        _, files = firmware.verify(self.bundle, 'iMacPro1,1')
        self.assertEqual(files['brcmfmac4364b2-pcie.txt'], self.inputs[nvram])
        self.assertEqual(files['brcmfmac4364b2-pcie.txcap_blob'], self.inputs[txcap])
        self.bundle.unlink()
        for invalid in (plistlib.dumps([]), plistlib.dumps({'RequestedFiles': '../../private/calibration'})):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.prepare(model='iMacPro1,1', requested_files=invalid)
            self.assertFalse(self.bundle.exists())

    def test_missing_wifi_bluetooth_or_wrong_model_fails_before_staging(self):
        self.prepare()
        output = self.root / 'staged'
        for model in ('MacBookPro16,1', 'Mac14,2', '../escape'):
            with self.subTest(model=model), self.assertRaises(ValueError):
                firmware.stage(self.bundle, output, model)
            self.assertFalse(output.exists())
        _, files = firmware.verify(self.bundle, self.model)
        for remove in ('brcmbt4377b3-apple,hawaii-m.ptb', 'brcmfmac4377b3-pcie.apple,fiji.bin'):
            missing = dict(files)
            missing.pop(remove)
            with self.subTest(remove=remove), self.assertRaises(ValueError):
                firmware.validate_files(missing, self.model)

    def test_source_symlink_special_file_and_size_limits_do_not_publish(self):
        path = self.source / 'wifi/C-4377__s-B3/fiji.trx'
        path.unlink()
        path.symlink_to(self.root / 'outside')
        (self.root / 'outside').write_bytes(b'private')
        with self.assertRaises((OSError, ValueError)):
            self.prepare()
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(ValueError):
            self.prepare()
        path.unlink()
        path.write_bytes(b'oversized')
        with patch.object(firmware, 'MAX_FILE', 2), self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.bundle.exists())
        original = self.source / 'bluetooth'
        original.rename(self.source / 'elsewhere')
        original.symlink_to(self.source / 'elsewhere', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symbolic links'):
            self.prepare()

    def test_memory_and_file_count_budgets_are_enforced(self):
        for name, value in [('MAX_TOTAL', 1), ('MAX_FILES', 1)]:
            with self.subTest(name=name), patch.object(firmware, name, value), self.assertRaises(ValueError):
                self.prepare()
            self.assertFalse(self.bundle.exists())

    def test_failed_staging_removes_only_its_new_directory(self):
        self.prepare()
        (self.root / 'keep').write_bytes(b'existing work')
        output = self.root / 'staged'
        with patch.object(firmware.os, 'fsync', side_effect=OSError('fixture disk full')), self.assertRaises(OSError):
            firmware.stage(self.bundle, output, self.model)
        self.assertFalse(output.exists())
        self.assertEqual((self.root / 'keep').read_bytes(), b'existing work')
        firmware.verify(self.bundle, self.model)

    def test_corrupt_missing_or_extra_contents_cannot_be_materialized(self):
        self.prepare()
        original = self.entries()
        broken = [original[:-1], original + [('brcm/brcmfmac4377b3-pcie.apple,other.bin', b'unlisted')],
                  original[:1] + [(original[1][0], b'corruption')] + original[2:]]
        for entries in broken:
            self.archive(entries)
            with self.subTest(entries=len(entries)), self.assertRaises(ValueError):
                firmware.stage(self.bundle, self.root / 'staged', self.model)
            self.assertFalse((self.root / 'staged').exists())

    def test_archive_links_duplicates_traversal_special_and_large_entries_fail(self):
        self.prepare()
        original = self.entries()
        bad_entries = []
        for name in ('../outside', '/absolute', 'brcm/../outside', 'brcm/a/b', 'manifest.json'):
            bad_entries.append((name, b'x'))
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.DIRTYPE):
            entry = tarfile.TarInfo('brcm/link')
            entry.mode, entry.type, entry.linkname = 0o644, kind, '/outside'
            bad_entries.append((entry, b''))
        for bad in bad_entries:
            self.archive(original + [bad])
            with self.subTest(entry=bad[0]), self.assertRaises(ValueError):
                firmware.verify(self.bundle, self.model)
        self.archive(original)
        with patch.object(firmware, 'MAX_ARCHIVE', 8), self.assertRaises(ValueError):
            firmware.verify(self.bundle, self.model)
        with patch.object(firmware, 'MAX_FILE', 4), self.assertRaises(ValueError):
            firmware.verify(self.bundle, self.model)

    def test_manifest_requires_unique_exact_fields_and_integrity(self):
        self.prepare()
        original = self.entries()
        manifest = json.loads(original[0][1])
        mutations = [{'model': 'MacBookPro16,1'}, {'schema': True}, {'schema': 2},
                     {'files': {}}, {'extra': 'ignored?'}, {'platform': 'x86_64'}]
        for change in mutations:
            altered = dict(manifest, **change)
            self.archive([('manifest.json', json.dumps(altered).encode())] + original[1:])
            with self.subTest(change=change), self.assertRaises(ValueError):
                firmware.verify(self.bundle, self.model)
        duplicate = original[0][1].rstrip().removesuffix(b'}') + b', "schema": 1}'
        self.archive([('manifest.json', duplicate)] + original[1:])
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            firmware.verify(self.bundle, self.model)

    def test_conflicting_dimensions_and_malformed_nvram_fail(self):
        for raw in (b'broken nvram', b'=empty key\n', b'\xff=non-ascii\n'):
            files = {'wifi/C-4377__s-B3/P-fiji.txt': raw}
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                firmware.names.convert(files)
        with self.assertRaises(ValueError):
            firmware.names.convert({'wifi/C-4377__s-B3/P-fiji_P-other.txt': b'x=1\n'})

    def test_cli_checks_and_stages_on_the_host_without_system_paths(self):
        self.prepare()
        for action in ('verify', 'stage'):
            args = [sys.executable, str(TOOL), action, '--bundle', str(self.bundle), '--model', self.model]
            if action == 'stage':
                args += ['--output', str(self.root / 'cli-staged')]
            result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=15)
            self.assertEqual(json.loads(result.stdout)['status'], 'verified')
        result = subprocess.run([sys.executable, str(TOOL), 'verify', '--bundle', str(self.bundle), '--model', 'Mac14,2'],
                                capture_output=True, text=True, timeout=15)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Traceback', result.stderr)

    def test_export_command_rejects_non_intel_hosts_without_reading_firmware(self):
        for operating_system, architecture in [('Linux', 'x86_64'), ('Darwin', 'arm64')]:
            with patch.object(sys, 'argv', ['prepare-t2-firmware.py', 'export', '--output', str(self.bundle)]), \
                 patch.object(firmware.platform, 'system', return_value=operating_system), \
                 patch.object(firmware.platform, 'machine', return_value=architecture), \
                 patch.object(firmware, 'source_files') as read, self.assertRaises(SystemExit) as error:
                firmware.main()
            self.assertEqual(error.exception.code, 1)
            read.assert_not_called()


if __name__ == '__main__':
    unittest.main()
