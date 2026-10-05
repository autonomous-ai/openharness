import copy
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

from payload_compression import compare, extract, measured
from zram_fixture import CHECKSUM, PAYLOAD, TARGET, boot_layout, compare_iso, expected_payload, inventory, replace_config
from zram_probe import check_capacity


class Capacity(unittest.TestCase):
    def test_exact_generated_capacity_uses_whole_mib_and_preserves_four_gib_cap(self):
        for total, mib in [(970648, 947), (2024000, 1976), (8 * 1024 ** 2, 4096)]:
            size = mib * 1024 ** 2
            swaps = 'Filename Type Size Used Priority\n/dev/zram0 partition ' + str(size // 1024 - 4) + ' 1 100\n'
            result = check_capacity(f'MemTotal: {total} kB\nMemAvailable: 100000 kB\n', size, swaps, 4096)
            self.assertEqual(result['expected_disksize_bytes'], size)

    def test_old_capacity_and_additional_swap_are_rejected(self):
        info = 'MemTotal: 970648 kB\n'
        with self.assertRaises(AssertionError):
            check_capacity(info, 496500736, '', 4096)
        with self.assertRaises(AssertionError):
            check_capacity(info, 993001472, 'header\n/dev/zram0 partition 969724 1 100\n/file file 20 0 -2\n', 4096)


class IsoBoundary(unittest.TestCase):
    def test_boot_entries_ignore_only_relocated_addresses(self):
        report = '''El Torito cat path : /boot/boot.cat
El Torito boot img : 1 BIOS y none 0x0000 0x00 4 200
El Torito img path : 1 /boot/bios.bin
El Torito img opts : 1 boot-info-table
El Torito boot img : 2 UEFI y none 0x0000 0x00 8192 202
El Torito img path : 2 /boot/efi.img
'''
        self.assertEqual(boot_layout(report), boot_layout(report.replace('4 200', '4 999')))
        self.assertNotEqual(boot_layout(report), boot_layout(report.replace('8192 202', '1024 202')))

    def test_only_expected_files_and_documented_boot_address_bytes_can_change(self):
        with tempfile.TemporaryDirectory() as temp:
            original, candidate = Path(temp) / 'old', Path(temp) / 'new'
            original.mkdir(); candidate.mkdir()
            values = {PAYLOAD: b'old-payload', CHECKSUM: b'old-checksum',
                      'boot/bios.bin': b'x' * 128, 'boot/efi.img': b'efi',
                      'boot/boot.cat': b'catalog', 'boot/kernel': b'kernel'}
            before = dict(entries={}, hardlinks=[])
            for name, data in values.items():
                for root in [original, candidate]:
                    path = root / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
                before['entries'][name] = dict(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), mode=0o100644)
            after = copy.deepcopy(before)
            for name in [PAYLOAD, CHECKSUM, 'boot/boot.cat']:
                after['entries'][name]['sha256'] = 'changed'
            data = bytearray(values['boot/bios.bin']); data[12] = 0
            (candidate / 'boot/bios.bin').write_bytes(data)
            after['entries']['boot/bios.bin']['sha256'] = hashlib.sha256(data).hexdigest()
            layout = dict(paths={'1': 'boot/bios.bin', '2': 'boot/efi.img'},
                          options={'1': ['boot-info-table']}, catalog='boot/boot.cat')
            self.assertTrue(compare_iso(before, after, original, candidate, layout)['all_other_paths_content_and_metadata_identical'])
            after['entries']['boot/kernel']['sha256'] = 'unexpected'
            with self.assertRaisesRegex(AssertionError, 'Unexpected ISO changes'):
                compare_iso(before, after, original, candidate, layout)
            after['entries']['boot/kernel'] = before['entries']['boot/kernel']
            data[80] = 0; (candidate / 'boot/bios.bin').write_bytes(data)
            with self.assertRaisesRegex(AssertionError, 'outside its replay address'):
                compare_iso(before, after, original, candidate, layout)

    def test_hidden_efi_partition_preserves_actual_bytes_across_relocation(self):
        # Exact hidden-image report fields from the retained preview 14 failure.
        report = '''El Torito cat path : /boot/syslinux/boot.cat
El Torito boot img :   1  BIOS  y   none  0x0000  0x00      4         115
El Torito boot img :   2  UEFI  y   none  0x0000  0x00      0      937480
El Torito img path :   1  /boot/syslinux/isolinux.bin
El Torito img opts :   1  boot-info-table isohybrid-suitable
El Torito img blks :   2  42496
'''
        with patch('zram_fixture.boot_image_digest', return_value='efi-digest') as read:
            layout = boot_layout(report, Path('preview14.iso'))
            read.assert_called_once_with(Path('preview14.iso'), 937480, 42496)
            self.assertEqual(layout['hidden_images']['2'], dict(blocks=42496, sha256='efi-digest'))
        with tempfile.TemporaryDirectory() as temp:
            original, relocated = Path(temp) / 'old.iso', Path(temp) / 'new.iso'
            original.write_bytes(b'\0' * 3 * 2048 + b'e' * 2 * 2048)
            relocated.write_bytes(b'\0' * 5 * 2048 + b'e' * 2 * 2048)
            small = report.replace('937480', '3').replace('42496', '2')
            moved = small.replace('      3\n', '      5\n')
            expected = boot_layout(small, original)
            self.assertEqual(expected, boot_layout(moved, relocated))
            with relocated.open('r+b') as handle:
                handle.seek(5 * 2048 + 12); handle.write(b'x')
            self.assertNotEqual(expected, boot_layout(moved, relocated))
            with self.assertRaises(AssertionError):
                boot_layout(moved.replace('   2  2\n', '   2  3\n'), relocated)


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0 and
                     all(shutil.which(t) for t in ['mksquashfs', 'unsquashfs']),
                     'Native Linux root/SquashFS fixture runs in the acceptance workflow')
class PayloadBoundary(unittest.TestCase):
    def test_one_file_roundtrip_preserves_metadata_links_and_unrelated_content(self):
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp); root = work / 'root'; target = root / TARGET
            target.parent.mkdir(parents=True)
            target.write_text('[zram0]\nzram-size = min(ram / 2, 4096)\n')
            target.chmod(0o640); os.utime(target, (123456, 123456))
            os.setxattr(target, 'user.harness-test', b'preserved')
            unrelated = root / 'other'; unrelated.write_bytes(b'runtime bytes unchanged')
            os.chown(unrelated, 1000, 1000); unrelated.chmod(0o4755)
            os.link(unrelated, root / 'hardlink'); (root / 'symlink').symlink_to('other')
            os.link(root / 'symlink', root / 'symlink-link', follow_symlinks=False)
            os.mkfifo(root / 'fifo'); os.link(root / 'fifo', root / 'fifo-link')
            before = inventory(root); data = b'[zram0]\nzram-size = min(ram, 4096)\n'
            self.assertIn(['symlink', 'symlink-link'], before['hardlinks'])
            self.assertIn(['fifo', 'fifo-link'], before['hardlinks'])
            expected = expected_payload(before, data)
            replace_config(root, data)
            self.assertIsNone(compare(expected, inventory(root)))
            image = work / 'candidate.sfs'
            measured(['mksquashfs', root, image, '-noappend', '-no-progress', '-comp', 'zstd',
                      '-processors', '2', '-mem', '64M'], work, 'compress', timeout=30)
            extract(image, work / 'extracted', work, 'extract')
            self.assertIsNone(compare(expected, inventory(work / 'extracted')))


if __name__ == '__main__':
    unittest.main()
