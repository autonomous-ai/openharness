import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import call, patch

spec = importlib.util.spec_from_file_location('session_settings',
    Path(__file__).resolve().parents[1] / 'root/usr/lib/harness-os/session-settings.py')
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


class SavedSessionSettings(unittest.TestCase):
    def test_old_os_footer_is_reset_to_the_tuis_current_defaults(self):
        with patch.object(settings, 'hn', side_effect=['#{@harness-update}', '60', '', '', '']) as hn:
            settings.migrate()
        self.assertIn((('set-option', '-gu', 'status-right'),), hn.call_args_list)
        self.assertIn((('set-option', '-gu', 'status-right-length'),), hn.call_args_list)
        self.assertEqual(hn.call_args.args, ('set-option', '-goq', '@hn-new-window', 'shell'))

    def test_custom_footer_and_length_are_preserved(self):
        with patch.object(settings, 'hn', side_effect=['my own footer', '']) as hn:
            settings.migrate()
        self.assertEqual(hn.call_count, 2)
        with patch.object(settings, 'hn', side_effect=['#{@harness-update}', '100', '', '']) as hn:
            settings.migrate()
        self.assertNotIn((('set-option', '-gu', 'status-right-length'),), hn.call_args_list)

    def test_usb_configuration_is_not_migrated(self):
        with patch.object(settings.Path, 'exists', return_value=True), patch.object(settings, 'migrate') as migrate:
            settings.main()
        migrate.assert_not_called()


class MigrationConnection(unittest.TestCase):
    def setUp(self):
        # Keep real AF_UNIX paths below macOS's pathname-length limit.
        temporary = tempfile.TemporaryDirectory(prefix='hn-settings-', dir='/tmp')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        environment = patch.dict(os.environ, {'HN_TMPDIR': str(self.root)}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        self.target = self.root / ('hn-' + str(os.getuid())) / 'default.sock'

    def bind(self):
        self.target.parent.mkdir(parents=True, exist_ok=True)
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(str(self.target))
        listener.listen()
        return listener

    def test_socket_location_matches_tui_environment_precedence(self):
        cases = [
            ({}, Path('/tmp/hn-1234/default.sock')),
            ({'TMUX_TMPDIR': '/alternate', 'HN_SOCKET_NAME': 'screen'}, Path('/alternate/hn-1234/screen.sock')),
            ({'HN_TMPDIR': '/preferred', 'TMUX_TMPDIR': '/alternate'}, Path('/preferred/hn-1234/default.sock')),
            ({'HN_TMPDIR': '', 'TMUX_TMPDIR': '/alternate'}, Path('hn-1234/default.sock')),
            ({'HN_SOCKET_NAME': '', 'TMUX_TMPDIR': ''}, Path('hn-1234/default.sock')),
            ({'HN_SOCKET': '/chosen/client.sock', 'HN_TMPDIR': '/elsewhere'}, Path('/chosen/client.sock')),
            ({'HN_SOCKET': '', 'HN_SOCKET_NAME': 'screen'}, Path('/tmp/hn-1234/screen.sock')),
        ]
        for environment, expected in cases:
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True), \
                    patch.object(settings.os, 'getuid', return_value=1234):
                self.assertEqual(settings.server_socket(), expected)

    def test_missing_or_nonsocket_path_never_invokes_hn(self):
        with patch.object(settings.subprocess, 'run') as run:
            with self.assertRaises(FileNotFoundError):
                settings.hn('show-options', '-gv', 'status-right')
            self.target.parent.mkdir(parents=True)
            self.target.write_text('not a server')
            with self.assertRaises(FileNotFoundError):
                settings.hn('show-options', '-gv', 'status-right')
            self.target.unlink()
            self.target.mkdir()
            with self.assertRaises(FileNotFoundError):
                settings.hn('show-options', '-gv', 'status-right')
        run.assert_not_called()

    def test_available_socket_is_always_explicit_and_command_is_bounded(self):
        self.bind()
        with patch.object(settings.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'my footer\n')) as run:
            self.assertEqual(settings.hn('show-options', '-gv', 'status-right'), 'my footer')
        run.assert_called_once_with(['/usr/bin/hn', '-S', str(self.target), 'show-options', '-gv', 'status-right'],
                                    check=True, text=True, capture_output=True, timeout=3)

    def test_startup_waits_without_starting_a_server_then_migrates(self):
        waits = []
        def ready_after_two_waits(seconds):
            self.assertEqual(run.call_count, 0, 'hn must not run before the graphical socket exists')
            waits.append(seconds)
            if len(waits) == 2:
                self.bind()
        replies = [subprocess.CompletedProcess([], 0, 'my own footer\n'), subprocess.CompletedProcess([], 0, '')]
        with patch.object(settings.Path, 'exists', return_value=False), \
                patch.object(settings.time, 'monotonic', side_effect=[0, .2, .4]), \
                patch.object(settings.time, 'sleep', side_effect=ready_after_two_waits), \
                patch.object(settings.subprocess, 'run', side_effect=replies) as run:
            settings.main()
        self.assertEqual(waits, [.2, .2])
        self.assertEqual([c.args[0] for c in run.call_args_list], [
            ['/usr/bin/hn', '-S', str(self.target), 'show-options', '-gv', 'status-right'],
            ['/usr/bin/hn', '-S', str(self.target), 'set-option', '-goq', '@hn-new-window', 'shell'],
        ])

    def test_unavailable_socket_stops_at_existing_retry_deadline(self):
        with patch.object(settings.Path, 'exists', return_value=False), \
                patch.object(settings.time, 'monotonic', side_effect=[10, 14.9, 25]), \
                patch.object(settings.time, 'sleep') as sleep, patch.object(settings.subprocess, 'run') as run:
            with self.assertRaises(FileNotFoundError):
                settings.main()
        sleep.assert_called_once_with(.2)
        run.assert_not_called()

    def test_stale_socket_and_cli_timeout_never_fall_back_or_retry_forever(self):
        self.bind().close()  # The Unix socket pathname remains, with no listener.
        command = ['/usr/bin/hn', '-S', str(self.target), 'show-options', '-gv', 'status-right']
        for failure in (subprocess.CalledProcessError(1, command), subprocess.TimeoutExpired(command, 3)):
            with self.subTest(failure=type(failure).__name__), \
                    patch.object(settings.Path, 'exists', return_value=False), \
                    patch.object(settings.time, 'monotonic', side_effect=[10, 14.9, 25]), \
                    patch.object(settings.time, 'sleep') as sleep, \
                    patch.object(settings.subprocess, 'run', side_effect=failure) as run:
                with self.assertRaises(type(failure)):
                    settings.main()
                self.assertEqual(run.call_args_list, [call(command, check=True, text=True, capture_output=True, timeout=3)] * 2)
                sleep.assert_called_once_with(.2)
