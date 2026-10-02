import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1] / 'installer.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class DiskSafety(unittest.TestCase):
    def disk(self, **changes):
        return dict({'type': 'disk', 'ro': False, 'size': 32 * 1024**3,
                     'mountpoints': [None], 'serial': 'HN_TEST', 'children': []}, **changes)

    def test_partition_device_names(self):
        self.assertEqual(installer.partitions('/dev/nvme0n1')[-1], '/dev/nvme0n1p3')
        self.assertEqual(installer.partitions('/dev/mmcblk0')[-1], '/dev/mmcblk0p3')
        self.assertEqual(installer.partitions('/dev/sda')[-1], '/dev/sda3')

    def test_live_usb_and_mounted_nested_mapper_are_rejected(self):
        for mount in ['/run/archiso/bootmnt', '/', '/home']:
            disk = self.disk(children=[{'mountpoints': [None], 'children': [{'mountpoints': [mount]}]}])
            with self.assertRaises(ValueError):
                installer.validate_disk(disk)

    def test_requires_writable_whole_disk_with_space(self):
        for changes in [{'ro': True}, {'type': 'part'}, {'type': 'loop'}, {'size': 1024}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                installer.validate_disk(self.disk(**changes))

    def test_unattended_serial_must_match(self):
        installer.validate_disk(self.disk(), 'HN_TEST')
        with self.assertRaises(ValueError):
            installer.validate_disk(self.disk(), 'ANOTHER_DISK')
        with self.assertRaises(ValueError):
            installer.validate_disk(self.disk(serial=None), 'HN_TEST')

    def test_reserved_image_account_is_rejected_before_any_disk_write(self):
        config = dict(username='daemon', hostname='test', password='test-password', encrypt=True,
                      disk='/dev/vda', confirm_erase='/dev/vda')
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'payload.sfs'
            source.touch()
            with patch.object(installer, 'selected_disk', return_value=self.disk()), \
                 patch.object(installer.shutil, 'which', return_value='/usr/bin/tool'), \
                 patch.object(installer, 'run', return_value='root:x:0:0::/root:/bin/bash\ndaemon:x:2:2::/:/usr/bin/nologin\n') as commands:
                with self.assertRaisesRegex(ValueError, 'reserves the username'):
                    installer.install(config, source, Path(temp) / 'target')
                self.assertEqual([call.args[0] for call in commands.call_args_list], ['unsquashfs'])
                self.assertFalse((Path(temp) / 'target').exists())

    def test_corrupt_offline_kernel_is_rejected_before_any_disk_write(self):
        config = dict(username='programmer', hostname='test', password='test-password', encrypt=True,
                      disk='/dev/vda', confirm_erase='/dev/vda')
        kernel = {'path': 'usr/lib/modules/6.12.1-lts/vmlinuz', 'sha256': hashlib.sha256(b'valid-kernel').hexdigest()}
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'payload.sfs'
            source.touch()
            with patch.object(installer, 'selected_disk', return_value=self.disk()), \
                 patch.object(installer.shutil, 'which', return_value='/usr/bin/tool'), \
                 patch.object(installer, 'run', side_effect=['root:x:0:0::/root:/bin/bash\n', json.dumps({'architecture': 'x86_64', 'version': 'preview'}), json.dumps(kernel)]) as commands, \
                 patch.object(installer.subprocess, 'check_output', return_value=b'corrupt-kernel'):
                with self.assertRaisesRegex(ValueError, 'kernel failed verification'):
                    installer.install(config, source, Path(temp) / 'target')
                self.assertTrue(all(call.args[0] == 'unsquashfs' for call in commands.call_args_list))
                self.assertFalse((Path(temp) / 'target').exists())

    def test_config_cannot_inject_commands_or_password_lines(self):
        good = dict(username='programmer', hostname='thinkpad', password='test-password', encrypt=True, disk='/dev/sda')
        installer.validate_config(good)
        for change in [dict(username='root'), dict(username='x;reboot'), dict(hostname='bad name'),
                       dict(password='password\nroot:injected'), dict(disk='/dev/sda;reboot'), dict(encrypt='yes'),
                       dict(username=None), dict(password=123456789), dict(hostname='bad-')]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                installer.validate_config(dict(good, **change))


if __name__ == '__main__':
    unittest.main()
