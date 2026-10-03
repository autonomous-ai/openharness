import importlib.util
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
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

    def test_unmounted_programmer_usb_is_rejected_after_copy_to_ram(self):
        image = dict(fstype='iso9660', label='HN_OS', mountpoints=[None])
        for changes in [image, dict(children=[image])]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, 'booted into RAM'):
                installer.validate_disk(self.disk(**changes))
        installer.validate_disk(self.disk(fstype='btrfs', label='HNROOT'))

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


class LivePayload(unittest.TestCase):
    def test_usb_ram_copy_and_mounted_media_are_both_supported(self):
        with tempfile.TemporaryDirectory() as temp:
            ram, media = Path(temp) / 'copytoram.sfs', Path(temp) / 'bootmnt.sfs'
            with patch.object(installer, 'LIVE_PAYLOADS', (ram, media)):
                with self.assertRaisesRegex(ValueError, 'Live system payload is missing'):
                    installer.live_payload()
                media.touch()
                self.assertEqual(installer.live_payload(), media)
                ram.touch()
                self.assertEqual(installer.live_payload(), ram)
                media.unlink()
                self.assertEqual(installer.live_payload(), ram)

    def test_explicit_source_is_honored_and_never_silently_replaced(self):
        with tempfile.TemporaryDirectory() as temp:
            available, explicit = Path(temp) / 'available.sfs', Path(temp) / 'explicit.sfs'
            available.touch()
            with patch.object(installer, 'LIVE_PAYLOADS', (available,)):
                with self.assertRaisesRegex(ValueError, 'explicit.sfs'):
                    installer.live_payload(explicit)
                explicit.touch()
                self.assertEqual(installer.live_payload(explicit), explicit)


class Screen:
    """Capture drawn text and supply keys; never expose a real disk or terminal."""
    def __init__(self):
        self.keys, self.frames, self.drawn = [], [], []
        self.size = (24, 80)

    def getmaxyx(self):
        return self.size

    def erase(self):
        self.drawn = []

    clear = erase

    def addnstr(self, row, column, text, length, attr):
        self.drawn.append(text[:length])

    def addstr(self, row, column, text, attr):
        self.drawn.append(text)

    def refresh(self):
        self.frames.append('\n'.join(self.drawn))

    def keypad(self, enabled):
        pass

    def move(self, row, column):
        assert 0 <= row < self.size[0] and 0 <= column < self.size[1]

    def get_wch(self):
        if not self.keys:
            raise AssertionError('The form requested another key after the test finished.')
        return self.keys.pop(0)


class InstallationCompletion(unittest.TestCase):
    def test_success_stays_visible_until_shutdown_or_return_is_chosen(self):
        for keys, shutdown in [(['\n'], True), (['\t', '\n'], False), (['\x1b'], False)]:
            screen = Screen()
            screen.keys = keys
            with self.subTest(keys=keys), patch.object(installer.curses, 'curs_set'), patch.object(installer.curses, 'flushinp') as flush:
                self.assertEqual(installer.completion(screen), shutdown)
                flush.assert_called_once()
                self.assertIn('Harness is installed.', screen.frames[0])
                self.assertIn('Remove the USB after shutdown.', screen.frames[0])


class InteractiveInstall(unittest.TestCase):
    def setUp(self):
        context = ExitStack()
        self.addCleanup(context.close)
        self.output = io.StringIO()
        context.enter_context(redirect_stdout(self.output))
        self.argv = ['install.py']
        context.enter_context(patch.object(installer.sys, 'argv', self.argv))
        context.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
        self.disk = dict(name='/dev/vda', type='disk', ro=False, size=32 * 1024**3,
                         model='Test SSD', mountpoints=[None], serial='HN_TEST', children=[])
        self.inventory = context.enter_context(patch.object(installer, 'inventory', return_value=[self.disk]))
        self.screen = Screen()
        context.enter_context(patch.object(installer.curses, 'flushinp'))
        self.completion = context.enter_context(patch.object(installer, 'completion', return_value=False))
        self.wrapper = context.enter_context(patch.object(installer.curses, 'wrapper', side_effect=lambda fn: fn(self.screen)))
        context.enter_context(patch.object(installer.curses, 'curs_set'))
        context.enter_context(patch.object(installer.curses, 'set_escdelay'))
        context.enter_context(patch.object(installer.sys.stdin, 'isatty', return_value=True))
        context.enter_context(patch.object(self.output, 'isatty', return_value=True))
        self.install = context.enter_context(patch.object(installer, 'install'))
        self.payload = context.enter_context(patch.object(installer, 'live_payload', return_value=Path('/test-live.sfs')))
        self.secret = 'test-password-123'

    def fill_passwords(self):
        # Disk -> encryption -> password -> repeat -> Install button via Enter.
        self.screen.keys.extend(['\t', '\t', *self.secret, '\n', *self.secret, '\n'])

    def confirm(self):
        self.screen.keys.append('\n')  # Activate Install; no second confirmation screen.

    def test_install_button_masks_password_and_installs_selected_disk(self):
        self.fill_passwords()
        self.confirm()
        installer.main()
        config = self.install.call_args.args[0]
        self.assertEqual((config['username'], config['hostname'], config['encrypt']), ('me', 'harness', True))
        self.assertEqual(config['confirm_erase'], '/dev/vda')
        self.assertEqual(config['expected_serial'], 'HN_TEST')
        self.assertEqual(config['password'], self.secret)
        self.assertIn('Encryption        [x]', self.screen.frames[0])
        first = self.screen.frames[0]
        for clutter in ('me@', '/dev/', 'HN_TEST', 'Tab move', 'Space toggle', 'eight characters'):
            self.assertNotIn(clutter, first)
        for label in ('Disk', 'Encryption', 'Password', 'Repeat password'):
            self.assertTrue(any(row.startswith(f'{label:18}') for row in first.splitlines()))
        for frame in self.screen.frames:
            self.assertNotIn(self.secret, frame)

    def test_short_password_is_accepted_but_empty_password_is_not(self):
        self.secret = 'a'
        self.fill_passwords()
        self.confirm()
        installer.main()
        self.assertEqual(self.install.call_args.args[0]['password'], 'a')
        config = dict(self.install.call_args.args[0], password='')
        with self.assertRaisesRegex(ValueError, 'Enter a password'):
            installer.validate_config(config)

    def test_shutdown_is_offered_only_after_a_successful_install(self):
        self.fill_passwords()
        self.confirm()
        self.completion.return_value = True
        with patch.object(installer, 'run') as command:
            command.side_effect = lambda *args: self.install.assert_called_once()
            installer.main()
            command.assert_called_once_with('systemctl', 'poweroff')
        self.screen.keys = []
        self.fill_passwords()
        self.confirm()
        self.completion.reset_mock()
        self.install.side_effect = ValueError('fixture disk failure')
        with patch.object(installer, 'run') as command, self.assertRaisesRegex(ValueError, 'fixture disk failure'):
            installer.main()
        self.completion.assert_not_called()
        command.assert_not_called()

    def test_command_line_keeps_explicit_unencrypted_and_custom_account_installation(self):
        self.argv.extend(['--no-encryption', '--username', 'sam', '--hostname', 'workbox'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        config = self.install.call_args.args[0]
        self.assertEqual((config['username'], config['hostname'], config['encrypt']), ('sam', 'workbox', False))
        self.assertIn('Encryption        [ ]', self.screen.frames[0])

    def test_main_form_checkbox_can_disable_encryption(self):
        self.screen.keys.extend(['\t', ' ', '\t', *self.secret, '\n', *self.secret, '\n'])
        self.confirm()
        installer.main()
        self.assertFalse(self.install.call_args.args[0]['encrypt'])

    def test_finishing_passwords_only_focuses_install_and_escape_cancels(self):
        self.fill_passwords()
        self.screen.keys.append('\x1b')
        with self.assertRaises(KeyboardInterrupt):
            installer.main()
        self.install.assert_not_called()
        self.assertTrue(all('Install Harness on this disk?' not in f for f in self.screen.frames))

    def test_selecting_another_disk_does_not_start_installation(self):
        self.inventory.return_value.append(dict(self.disk, name='/dev/vdb', serial='SECOND_DISK'))
        self.screen.keys.extend(['\n', installer.curses.KEY_DOWN, '\n'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        config = self.install.call_args.args[0]
        self.assertEqual((config['disk'], config['confirm_erase'], config['expected_serial']),
                         ('/dev/vdb', '/dev/vdb', 'SECOND_DISK'))
        picker = next(f for f in self.screen.frames if f.startswith('Select disk'))
        disk_rows = [r for r in picker.splitlines() if '/dev/' in r]
        self.assertEqual(len(disk_rows), 2)
        self.assertTrue(all('Test SSD' in r and 'GB' in r for r in disk_rows))

    def test_escaping_disk_picker_preserves_original_selection(self):
        self.inventory.return_value.append(dict(self.disk, name='/dev/vdb', serial='SECOND_DISK'))
        self.screen.keys.extend(['\n', installer.curses.KEY_DOWN, '\x1b'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        self.assertEqual(self.install.call_args.args[0]['disk'], '/dev/vda')

    def test_password_mismatch_can_be_corrected_without_restarting(self):
        self.screen.keys.extend(['\t', '\t', *self.secret, '\n', *'different', '\n', '\n', installer.curses.KEY_BTAB, '\x15', *self.secret, '\n'])
        self.confirm()
        installer.main()
        self.assertTrue(any('Passwords do not match.' in frame for frame in self.screen.frames))
        self.assertEqual(self.install.call_args.args[0]['password'], self.secret)

    def test_live_usb_is_excluded_from_picker(self):
        self.inventory.return_value.insert(0, dict(self.disk, name='/dev/sda', mountpoints=['/run/archiso/bootmnt']))
        self.screen.keys.extend(['\n', '\n'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        self.assertEqual(self.install.call_args.args[0]['disk'], '/dev/vda')
        self.assertFalse(any('/dev/sda' in frame for frame in self.screen.frames))

    def test_ram_boot_usb_is_excluded_from_picker(self):
        self.inventory.return_value.insert(0, dict(self.disk, name='/dev/sda',
                                                  fstype='iso9660', label='HN_OS'))
        self.fill_passwords()
        self.confirm()
        installer.main()
        self.assertEqual(self.install.call_args.args[0]['disk'], '/dev/vda')

    def test_missing_live_payload_stops_before_password_entry(self):
        self.payload.side_effect = ValueError('Live system payload is missing')
        with self.assertRaisesRegex(ValueError, 'Live system payload is missing'):
            installer.main()
        self.install.assert_not_called()
        self.wrapper.assert_not_called()

    def test_disk_replacement_is_rejected_when_install_is_pressed(self):
        self.inventory.side_effect = [[self.disk], [dict(self.disk, serial='REPLACED')]]
        self.fill_passwords()
        self.confirm()
        self.screen.keys.append('\x1b')
        with self.assertRaises(KeyboardInterrupt):
            installer.main()
        self.install.assert_not_called()
        self.assertTrue(any('Disk serial does not match' in frame for frame in self.screen.frames))

    def test_small_terminal_can_cancel_without_starting_installation(self):
        self.screen.size = (12, 40)
        self.screen.keys.append('\x1b')
        with self.assertRaises(KeyboardInterrupt):
            installer.main()
        self.install.assert_not_called()

    def test_no_eligible_disk_stops_before_password_entry(self):
        self.inventory.return_value = [dict(self.disk, ro=True)]
        with self.assertRaisesRegex(ValueError, 'No unmounted'):
            installer.main()
        self.install.assert_not_called()
        self.wrapper.assert_not_called()

    def test_configuration_file_cannot_silently_conflict_with_command_line_overrides(self):
        self.argv.extend(['--config', '/unused.json', '--no-encryption', '--yes-erase-disk'])
        with self.assertRaisesRegex(ValueError, 'set account names and encryption in that file'):
            installer.main()
        self.install.assert_not_called()
        self.wrapper.assert_not_called()


if __name__ == '__main__':
    unittest.main()
