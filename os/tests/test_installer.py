import importlib.util
from contextlib import ExitStack, redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import sys
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


class EncryptionMemory(unittest.TestCase):
    def budget(self, total_mib, available_mib, swap_mib=0):
        with tempfile.TemporaryDirectory() as temp:
            info = Path(temp) / 'meminfo'
            info.write_text(f'MemTotal: {total_mib * 1024} kB\nMemAvailable: {available_mib * 1024} kB\nSwapFree: {swap_mib * 1024} kB\n')
            return installer.encryption_memory(info)

    def test_ram_backed_swap_does_not_increase_encryption_budget(self):
        self.assertEqual(self.budget(960, 400, swap_mib=480), 200 * 1024)
        self.assertEqual(self.budget(960, 400, swap_mib=4096), 200 * 1024)
        self.assertEqual(self.budget(960, 400), 200 * 1024)

    def test_budget_preserves_headroom_and_the_normal_one_gib_ceiling(self):
        self.assertEqual(self.budget(960, 224), 96 * 1024)
        self.assertEqual(self.budget(960, 192), 64 * 1024)
        self.assertEqual(self.budget(16384, 12000), 1024 * 1024)
        with self.assertRaisesRegex(ValueError, 'Close other harnesses'):
            self.budget(960, 191)

    def test_missing_or_invalid_memory_is_not_treated_as_available(self):
        with tempfile.TemporaryDirectory() as temp:
            info = Path(temp) / 'meminfo'
            for content in [None, '', 'MemTotal: 1000 kB\n',
                            'MemTotal: 1000 kB\nMemAvailable: 1001 kB\n']:
                if content is not None:
                    info.write_text(content)
                with self.assertRaisesRegex(ValueError, 'No disk has been erased'):
                    installer.encryption_memory(info)

    def test_insufficient_memory_stops_before_creating_or_erasing_the_target(self):
        config = dict(username='me', hostname='harness', password='test-password',
                      encrypt=True, disk='/dev/vda', confirm_erase='/dev/vda')
        with tempfile.TemporaryDirectory() as temp:
            source, target = Path(temp) / 'payload', Path(temp) / 'target'
            source.touch()
            with patch.object(installer, 'selected_disk'), \
                 patch.object(installer, 'preflight'), \
                 patch.object(installer, 'trial_source'), \
                 patch.object(installer, 'encryption_memory', side_effect=ValueError('Not enough free memory')), \
                 patch.object(installer, 'run') as commands:
                with self.assertRaisesRegex(ValueError, 'Not enough free memory'):
                    installer.install(config, source, target)
                commands.assert_not_called()
                self.assertFalse(target.exists())

    def test_format_uses_the_budget_without_overriding_time_or_algorithm(self):
        config = dict(username='me', hostname='harness', password='test-password',
                      encrypt=True, disk='/dev/vda', confirm_erase='/dev/vda')
        def stop_at_open(*args, **kwargs):
            if args[:2] == ('cryptsetup', 'open'):
                raise OSError('stop before mapping a real disk')
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'payload'
            source.touch()
            with patch.object(installer, 'selected_disk'), \
                 patch.object(installer, 'preflight'), \
                 patch.object(installer, 'trial_source', return_value=None), \
                 patch.object(installer, 'encryption_memory', return_value=192 * 1024), \
                 patch.object(installer, 'run', side_effect=stop_at_open) as commands:
                with self.assertRaisesRegex(OSError, 'stop before mapping'):
                    installer.install(config, source, Path(temp) / 'target')
            call = next(c for c in commands.call_args_list if c.args[:2] == ('cryptsetup', 'luksFormat'))
            self.assertEqual(call.args[call.args.index('--pbkdf-memory') + 1], 192 * 1024)
            self.assertEqual(call.args[call.args.index('--type') + 1], 'luks2')
            self.assertEqual(call.kwargs['input'], b'test-password')
            for option in ['--iter-time', '--pbkdf-force-iterations', '--pbkdf', '--cipher', '--key-size']:
                self.assertNotIn(option, call.args)

    def test_plain_install_does_not_require_an_encryption_budget(self):
        config = dict(username='me', hostname='harness', password='test-password',
                      encrypt=False, disk='/dev/vda', confirm_erase='/dev/vda')
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp) / 'payload'
            source.touch()
            with patch.object(installer, 'selected_disk'), \
                 patch.object(installer, 'preflight'), \
                 patch.object(installer, 'trial_source', return_value=None), \
                 patch.object(installer, 'encryption_memory') as budget, \
                 patch.object(installer, 'run', side_effect=OSError('stop before erasing')):
                with self.assertRaisesRegex(OSError, 'stop before erasing'):
                    installer.install(config, source, Path(temp) / 'target')
                budget.assert_not_called()


class InstallerCleanup(unittest.TestCase):
    def test_deferred_close_does_not_wait_for_or_force_a_remaining_reader(self):
        with patch.object(installer, 'run') as command:
            installer.close_install_mapping('hn-install-test')
        command.assert_called_once_with('cryptsetup', 'close', '--deferred', 'hn-install-test', timeout=10)

    def test_slow_udev_or_busy_close_queues_kernel_removal_without_waiting_for_udev(self):
        for error in [subprocess.CalledProcessError(5, ['cryptsetup', 'close']),
                      subprocess.TimeoutExpired(['cryptsetup', 'close'], 4.66)]:
            with self.subTest(error=error), patch.object(installer.Path, 'exists', return_value=True), \
                 patch.object(installer, 'run', side_effect=[error, None]) as command:
                installer.close_install_mapping('hn-install-test')
                self.assertEqual(command.call_args_list[-1].args,
                                 ('dmsetup', 'remove', '--deferred', '--noudevsync', 'hn-install-test'))
                self.assertEqual(command.call_args_list[-1].kwargs, {'timeout': 3})

    def test_timeout_after_successful_removal_is_already_clean(self):
        with patch.object(installer.Path, 'exists', return_value=False), \
             patch.object(installer, 'run', side_effect=subprocess.TimeoutExpired(['cryptsetup'], 10)) as command:
            installer.close_install_mapping('hn-install-test')
            self.assertEqual(command.call_count, 1)

    def test_unexpected_close_error_and_failed_deferred_removal_remain_errors(self):
        error = subprocess.CalledProcessError(4, ['cryptsetup', 'close'])
        with patch.object(installer, 'run', side_effect=error) as command:
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                installer.close_install_mapping('hn-install-test')
            self.assertIs(caught.exception, error)
            self.assertEqual(command.call_count, 1)
        with patch.object(installer.Path, 'exists', return_value=True), \
             patch.object(installer, 'run', side_effect=[subprocess.TimeoutExpired(['cryptsetup'], 10), error]):
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                installer.close_install_mapping('hn-install-test')
            self.assertIs(caught.exception, error)

    def failed_install(self, unmount_failure=False, log_failure=False):
        config = dict(username='me', hostname='harness', password='private-password',
                      encrypt=True, disk='/dev/vda', confirm_erase='/dev/vda')
        original = subprocess.CalledProcessError(1, ['unsquashfs', 'payload.sfs'])
        cleanup = subprocess.CalledProcessError(5, ['cryptsetup', 'close', 'hn-install-test'])
        def command(*args, **kwargs):
            if args[0] == 'unsquashfs':
                raise original
            if unmount_failure and args[:2] == ('umount', '-R'):
                raise OSError('target is still mounted')
            return 'test-uuid'
        with tempfile.TemporaryDirectory() as temp:
            source, target, log = (Path(temp) / name for name in ('payload', 'target', 'install.log'))
            source.touch()
            with patch.object(installer, 'selected_disk'), \
                 patch.object(installer, 'preflight'), \
                 patch.object(installer, 'trial_source', return_value=None), \
                 patch.object(installer, 'encryption_memory', return_value=128 * 1024), \
                 patch.object(installer, 'run', side_effect=command), \
                 patch.object(installer, 'close_install_mapping', side_effect=cleanup) as close, \
                 installer.command_log(log), redirect_stdout(io.StringIO()) as output, ExitStack() as stack:
                if log_failure:
                    stack.enter_context(patch.object(installer.COMMAND_LOG, 'write', side_effect=OSError('log is full')))
                with self.assertRaises(subprocess.CalledProcessError) as caught:
                    installer.install(config, source, target)
            self.assertIs(caught.exception, original)
            self.assertIn('Disk cleanup also failed', original.__notes__[0])
            if not log_failure:
                self.assertIn('unsquashfs', log.read_text())
            self.assertNotIn('private-password', log.read_text())
            self.assertNotIn('Installed in', output.getvalue())
            self.assertEqual(close.call_count, 0 if unmount_failure else 1)

    def test_close_failure_never_hides_the_original_installation_error(self):
        self.failed_install()

    def test_failed_unmount_never_closes_a_still_mounted_mapping_or_hides_the_error(self):
        self.failed_install(unmount_failure=True)

    def test_failed_diagnostic_write_preserves_the_error_and_still_attempts_cleanup(self):
        self.failed_install(log_failure=True)


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

    def addnstr(self, row, column, text, length, attr=0):
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
        log_directory = context.enter_context(tempfile.TemporaryDirectory())
        context.enter_context(patch.object(installer, 'INSTALL_LOG', Path(log_directory) / 'install.log'))
        context.enter_context(patch.object(installer, 'LAST_LOG', None))
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
        # The safe disk is selected and Password is focused immediately.
        self.screen.keys.extend([*self.secret, '\n', *self.secret, '\n'])

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
        self.screen.keys.extend([installer.curses.KEY_BTAB, ' ', '\t', *self.secret, '\n', *self.secret, '\n'])
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
        self.screen.keys.extend([installer.curses.KEY_BTAB, installer.curses.KEY_BTAB, '\n', installer.curses.KEY_DOWN, '\n', '\t', '\t'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        config = self.install.call_args.args[0]
        self.assertEqual((config['disk'], config['confirm_erase'], config['expected_serial']),
                         ('/dev/vdb', '/dev/vdb', 'SECOND_DISK'))
        picker = next(f for f in self.screen.frames if 'Select disk' in f.splitlines())
        disk_rows = [r for r in picker.splitlines() if '/dev/' in r]
        self.assertEqual(len(disk_rows), 2)
        self.assertTrue(all('Test SSD' in r and 'GB' in r for r in disk_rows))
        self.assertTrue(any('vdb' in row for row in self.screen.frames[-1].splitlines() if row.startswith('Disk')))

    def test_long_disk_model_keeps_size_and_device_visible_on_a_small_screen(self):
        self.screen.size = (18, 54)
        self.disk['model'] = 'A very long manufacturer and model name' * 3
        self.screen.keys.extend([installer.curses.KEY_BTAB, installer.curses.KEY_BTAB, '\n', '\n', '\t', '\t'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        picker = next(f for f in self.screen.frames if 'Select disk' in f.splitlines())
        disk_row = next(row for row in picker.splitlines() if '/dev/' in row)
        self.assertIn('34.4 GB', disk_row)
        self.assertTrue(disk_row.endswith('/dev/vda'))
        self.assertIn('…', disk_row)
        self.assertTrue(any('34.4 GB' in row for row in self.screen.frames[-1].splitlines() if row.startswith('Disk')))

    def test_escaping_disk_picker_preserves_original_selection(self):
        self.inventory.return_value.append(dict(self.disk, name='/dev/vdb', serial='SECOND_DISK'))
        self.screen.keys.extend([installer.curses.KEY_BTAB, installer.curses.KEY_BTAB, '\n', installer.curses.KEY_DOWN, '\x1b', '\t', '\t'])
        self.fill_passwords()
        self.confirm()
        installer.main()
        self.assertEqual(self.install.call_args.args[0]['disk'], '/dev/vda')

    def test_password_mismatch_can_be_corrected_without_restarting(self):
        self.screen.keys.extend([*self.secret, '\n', *'different', '\n', '\n', installer.curses.KEY_BTAB, '\x15', *self.secret, '\n'])
        self.confirm()
        installer.main()
        self.assertTrue(any('Passwords do not match.' in frame for frame in self.screen.frames))
        self.assertEqual(self.install.call_args.args[0]['password'], self.secret)

    def test_live_usb_is_excluded_from_picker(self):
        self.inventory.return_value.insert(0, dict(self.disk, name='/dev/sda', mountpoints=['/run/archiso/bootmnt']))
        self.screen.keys.extend([installer.curses.KEY_BTAB, installer.curses.KEY_BTAB, '\n', '\n', '\t', '\t'])
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


class InstallerExit(unittest.TestCase):
    def exercise(self, failure, config=None, tty=True):
        with patch.object(installer, 'arguments', return_value=installer.argparse.Namespace(config=config)), \
             patch.object(installer, 'main', side_effect=failure), \
             patch.object(installer.sys.stdin, 'isatty', return_value=tty), \
             patch.object(installer.sys, 'stderr') as stderr, \
             patch('builtins.input') as acknowledge:
            stderr.isatty.return_value = tty
            status = installer.entrypoint()
            return status, acknowledge, ''.join(str(call.args[0]) for call in stderr.write.call_args_list)

    def test_interactive_failure_waits_for_acknowledgement_before_pane_closes(self):
        status, acknowledge, error = self.exercise(ValueError('Target disk was not found.'))
        self.assertEqual(status, 1)
        self.assertIn('Installation stopped: Target disk was not found.', error)
        acknowledge.assert_called_once_with('Press Enter to return to Harness.')

    def test_unattended_and_piped_failures_never_wait(self):
        for config, tty in [(Path('/tmp/install.json'), True), (None, False)]:
            with self.subTest(config=config, tty=tty):
                status, acknowledge, error = self.exercise(OSError('fixture read failure'), config, tty)
                self.assertEqual(status, 1)
                self.assertIn('fixture read failure', error)
                acknowledge.assert_not_called()

    def test_cleanup_context_and_command_timeout_remain_visible(self):
        failure = subprocess.TimeoutExpired(['cryptsetup', 'close', 'hn-install-test'], 10)
        failure.add_note('Harness was written and synced. Shut down normally.')
        status, acknowledge, error = self.exercise(failure)
        self.assertEqual(status, 1)
        self.assertIn('cryptsetup', error)
        self.assertIn('Harness was written and synced. Shut down normally.', error)
        acknowledge.assert_called_once()

    def test_deliberate_cancel_does_not_open_an_error_prompt(self):
        status, acknowledge, error = self.exercise(KeyboardInterrupt())
        self.assertEqual(status, 130)
        self.assertEqual(error, '')
        acknowledge.assert_not_called()

    def test_success_keeps_zero_status_without_an_extra_prompt(self):
        status, acknowledge, error = self.exercise(None)
        self.assertEqual(status, 0)
        self.assertEqual(error, '')
        acknowledge.assert_not_called()


class InstallerOutput(unittest.TestCase):
    def test_display_resize_does_not_abort_installation(self):
        config = dict(username='me', hostname='harness', encrypt=True)
        screen = Screen()
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(installer, 'INSTALL_LOG', Path(temp) / 'install.log'), \
             patch.object(installer, 'LAST_LOG', None), \
             patch.object(installer.curses, 'curs_set'), \
             patch.object(screen, 'erase', side_effect=installer.curses.error), \
             patch.object(installer, 'install', side_effect=lambda *args, progress: progress('Copying Harness…')) as install:
            installer.install_with_progress(screen, config, Path('/unused'), Path('/unused-target'))
            install.assert_called_once()
            self.assertIn('Copying Harness…', installer.INSTALL_LOG.read_text())

    def test_command_log_retains_diagnostics_and_excludes_password_input(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / 'install.log'
            log.write_text('stale log')
            log.chmod(0o644)
            with installer.command_log(log):
                installer.run(sys.executable, '-c',
                              "import sys; sys.stdin.read(); print('copied'); print('diagnostic', file=sys.stderr)",
                              input=b'private-password-123')
                self.assertEqual(installer.run(sys.executable, '-c', "print('metadata')", capture=True), 'metadata')
            text = log.read_text()
            self.assertIn('copied', text)
            self.assertIn('diagnostic', text)
            self.assertNotIn('private-password-123', text)
            self.assertNotIn('stale log', text)
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertIsNone(installer.COMMAND_LOG)

    def test_failed_command_is_not_success_and_log_redirection_is_restored(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp) / 'install.log'
            with self.assertRaises(subprocess.CalledProcessError):
                with installer.command_log(log):
                    installer.run(sys.executable, '-c', "import sys; print('disk error', file=sys.stderr); sys.exit(9)")
            self.assertIn('disk error', log.read_text())
            self.assertIsNone(installer.COMMAND_LOG)

    def test_log_cannot_follow_a_symlink(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'unrelated'
            target.write_text('preserve')
            log = Path(temp) / 'install.log'
            log.symlink_to(target)
            with self.assertRaises(OSError):
                with installer.command_log(log):
                    self.fail('A symlink must never be opened as the installer log')
            self.assertEqual(target.read_text(), 'preserve')


if __name__ == '__main__':
    unittest.main()
