import importlib.machinery
import importlib.util
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'root/usr/lib/harness-os/open-updates'
loader = importlib.machinery.SourceFileLoader('open_updates', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
updates = importlib.util.module_from_spec(spec)
loader.exec_module(updates)
SOCKET = '/run/user/1000/hn/default.sock'
TOKEN, NEW_TOKEN = 'a' * 32, 'b' * 32


class UpdatePaneOwnership(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / 'proc'
        self.rows, self.commands, self.targets = [], [], []
        self.attached = True
        self.boot_id = self.root / 'boot-id'
        self.boot_id.write_text('first-boot')
        for value in [patch.object(updates, 'PROC', self.proc),
                      patch.object(updates, 'BOOT_ID', self.boot_id),
                      patch.object(updates, 'STATE', self.root / 'state'),
                      patch.object(updates, 'hn', side_effect=self.hn),
                      patch.object(updates.secrets, 'token_hex', return_value=NEW_TOKEN),
                      patch.dict(os.environ, {}, clear=True),
                      patch.object(updates.subprocess, 'run')]:
            value.start()
            self.addCleanup(value.stop)
        self.request = updates.subprocess.run

    def process(self, pid, *, token=TOKEN, group=10, foreground=10,
                command=None, state='S', start=123, active=True):
        path = self.proc / str(pid)
        path.mkdir(parents=True, exist_ok=True)
        fields = [state, '1', str(group), '10', '34816', str(foreground)] + ['0'] * 13 + [str(start)]
        (path / 'stat').write_text(f'{pid} (a test (process)) ' + ' '.join(fields))
        argv = command if command is not None else ['/usr/bin/python3', updates.UPDATER, 'screen']
        (path / 'cmdline').write_bytes(b'\0'.join(word.encode() for word in argv) + b'\0')
        # Shipped daemon-backed panes have a backend TMUX_PANE and no HN_SOCKET.
        # Neither value may be used as the UI's pane/process mapping.
        (path / 'environ').write_bytes(('TMUX_PANE=%999\0HARNESS_UPDATE_INSTANCE=' + token + '\0').encode())
        screens = updates.STATE / 'screens'
        screens.mkdir(parents=True, exist_ok=True)
        if active:
            (screens / str(pid)).write_text(json.dumps(dict(
                pid=pid, start=str(start), token=token, boot_id='first-boot')))
        else:
            (screens / str(pid)).unlink(missing_ok=True)

    def pane(self, pane='%1', dead='0', window='@1', token=TOKEN):
        launch = '"exec env HARNESS_UPDATE_INSTANCE=' + token + ' /usr/bin/python3 ' + updates.UPDATER + ' screen"' if token else ''
        self.rows.append('\t'.join([pane, dead, window, launch]))

    def hn(self, *args, socket=None):
        self.commands.append(args)
        self.targets.append((args, socket))
        if args == ('display-message', '-p', '#{socket_path}'):
            self.assertIsNone(socket)
            return SOCKET
        self.assertEqual(socket, SOCKET)
        if args[0] == 'hn-list-clients':
            self.assertEqual(args, ('hn-list-clients', '-F', '#{client_tty}'))
            return '/dev/pts/7' if self.attached else ''
        if args[0] == 'list-panes':
            self.assertEqual(args, ('list-panes', '-s', '-F', updates.FORMAT))
            return '\n'.join(self.rows)
        if args[0] == 'new-window':
            self.assertEqual(args, ('new-window', '-P', '-F', '#{pane_id}', '-n', 'Updates',
                'exec env HARNESS_UPDATE_INSTANCE=' + NEW_TOKEN + ' /usr/bin/python3 ' + updates.UPDATER + ' screen'))
            self.pane('%9', window='@9', token=NEW_TOKEN)
            self.process(900, token=NEW_TOKEN)
            return '%9'
        self.assertIn(args[0], ['select-window', 'select-pane'])
        return ''

    def assert_created_once(self):
        self.assertEqual(sum(item[0] == 'new-window' for item in self.commands), 1)
        self.assertNotIn(('select-window', '-t', 'Updates'), self.commands)
        self.assertFalse(any(item[0] == 'set-option' for item in self.commands))

    def test_an_unrelated_named_shell_cannot_swallow_the_request(self):
        self.pane(token='')
        self.process(100, command=['/bin/bash'])
        updates.open_updates()
        self.assert_created_once()
        self.assertNotIn(('select-window', '-t', '@1'), self.commands)
        self.request.assert_called_once_with(['/usr/bin/harness', 'updates', 'request'],
                                             env={'HARNESS_UPDATE_TARGET': NEW_TOKEN}, check=True, timeout=5)

    def test_daemon_backed_owner_is_reused_without_backend_pid_or_socket_fields(self):
        self.pane()
        self.process(100)
        updates.open_updates()
        self.assertIn(('select-window', '-t', '@1'), self.commands)
        self.assertIn(('select-pane', '-t', '%1'), self.commands)
        self.assertFalse(any(item[0] == 'new-window' for item in self.commands))
        self.assertEqual(self.request.call_args.kwargs['env']['HARNESS_UPDATE_TARGET'], TOKEN)

    def test_manual_view_creates_no_request_and_next_shortcut_reuses_its_owner(self):
        self.assertTrue(updates.open_updates(view=True))
        self.request.assert_not_called()
        updates.open_updates()
        self.assert_created_once()
        self.request.assert_called_once()
        self.assertIn(('select-pane', '-t', '%9'), self.commands)

    def test_missing_dead_zombie_background_foreign_and_unregistered_are_not_reused(self):
        for case in ['missing', 'dead', 'zombie', 'background', 'token-mismatch', 'check', 'different-script', 'closed-screen']:
            with self.subTest(case=case):
                self.rows, self.commands = [], []
                shutil.rmtree(self.proc, ignore_errors=True)
                shutil.rmtree(updates.STATE, ignore_errors=True)
                self.pane(dead='1' if case == 'dead' else '0')
                if case != 'missing':
                    self.process(100, state='Z' if case == 'zombie' else 'S',
                                 foreground=20 if case == 'background' else 10,
                                 token='c' * 32 if case == 'token-mismatch' else TOKEN,
                                 active=case != 'closed-screen',
                                 command=['/usr/bin/python3', updates.UPDATER, 'check'] if case == 'check' else
                                         ['/usr/bin/python3', '/tmp/live_update.py'] if case == 'different-script' else None)
                updates.open_updates()
                self.assert_created_once()
                self.assertNotIn(('select-window', '-t', '@1'), self.commands)

    def test_registration_must_match_process_environment_not_just_launch(self):
        self.pane()
        self.process(100)
        (self.proc / '100/environ').write_bytes(b'TMUX_PANE=%1\0')
        updates.open_updates()
        self.assert_created_once()

    def test_ambiguous_duplicate_process_token_is_not_reused(self):
        self.pane()
        self.process(100)
        self.process(101)
        updates.open_updates()
        self.assert_created_once()

    def test_only_the_exact_fixed_quoted_launch_is_an_owner(self):
        valid = '"exec env HARNESS_UPDATE_INSTANCE=' + TOKEN + ' /usr/bin/python3 ' + updates.UPDATER + ' screen"'
        for launch in [valid[1:-1], valid.replace('exec env ', 'env '),
                       valid.replace(TOKEN, TOKEN.upper()), valid.replace(TOKEN, TOKEN[:-1]),
                       valid.replace('/usr/bin/python3', 'python3'),
                       valid.replace(updates.UPDATER, '/tmp/live_update.py'),
                       valid.replace(' screen', ' check'), valid[:-1] + '; true"',
                       valid.replace(' /usr/bin', ' EXTRA=1 /usr/bin', 1),
                       valid.replace(' screen', ' screen\\n'), valid + ' ',
                       valid.replace(' screen', ' screen\\"')]:
            with self.subTest(launch=launch):
                self.rows, self.commands = ['%1\t0\t@1\t' + launch], []
                shutil.rmtree(self.proc, ignore_errors=True)
                shutil.rmtree(updates.STATE, ignore_errors=True)
                self.process(100)
                updates.open_updates()
                self.assert_created_once()
                self.assertNotIn(('select-pane', '-t', '%1'), self.commands)

    def test_duplicate_matching_panes_cannot_choose_an_arbitrary_live_owner(self):
        for second in ['%1', '%2']:
            with self.subTest(second=second):
                self.rows, self.commands = [], []
                shutil.rmtree(self.proc, ignore_errors=True)
                shutil.rmtree(updates.STATE, ignore_errors=True)
                self.pane()
                self.pane(second)
                self.process(100)
                updates.open_updates()
                self.assert_created_once()
                self.assertNotIn(('select-window', '-t', '@1'), self.commands)

    def test_exit_pid_reuse_pane_removal_or_launch_change_during_selection_creates_new_owner(self):
        for case in ['exit', 'pid-reuse', 'pane-removed', 'token-removed']:
            with self.subTest(case=case):
                self.rows, self.commands = [], []
                shutil.rmtree(self.proc, ignore_errors=True)
                shutil.rmtree(updates.STATE, ignore_errors=True)
                self.pane()
                self.process(100)
                def select(*args, **kwargs):
                    result = self.hn(*args, **kwargs)
                    if args[0] == 'select-pane':
                        if case == 'pid-reuse':
                            self.process(100, start=456)
                        elif case == 'token-removed':
                            self.rows = ['%1\t0\t@1\t']
                        else:
                            shutil.rmtree(self.proc / '100')
                        if case == 'pane-removed':
                            raise subprocess.CalledProcessError(1, 'hn')
                    return result
                with patch.object(updates, 'hn', side_effect=select):
                    updates.open_updates()
                self.assert_created_once()

    def test_rapid_shortcuts_wait_for_new_registration_and_reuse_one_pane(self):
        ready = threading.Barrier(2)
        queries = 0
        def delayed(*args, **kwargs):
            nonlocal queries
            result = self.hn(*args, **kwargs)
            if args[0] == 'list-panes':
                queries += 1
                if queries < 4:
                    return ''
            return result
        def shortcut():
            ready.wait(timeout=2)
            updates.open_updates()
        with patch.object(updates, 'hn', side_effect=delayed), ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(shortcut) for _ in range(2)]
            for future in futures:
                future.result(timeout=3)
        self.assert_created_once()
        self.assertEqual(self.request.call_count, 2)
        self.assertIn(('select-pane', '-t', '%9'), self.commands)

    def test_failed_request_never_switches_or_creates_a_pane(self):
        self.request.side_effect = subprocess.CalledProcessError(1, 'harness')
        with self.assertRaises(subprocess.CalledProcessError):
            updates.open_updates()
        self.assertTrue(self.commands)  # Discover an owner before targeting it.
        self.assertFalse(any(args[0] in ['select-window', 'select-pane', 'new-window'] for args in self.commands))

    def test_startup_failure_is_bounded_and_does_not_create_more_panes(self):
        def never_starts(*args, **kwargs):
            result = self.hn(*args, **kwargs)
            return '' if args[0] == 'list-panes' else result
        with (patch.object(updates, 'hn', side_effect=never_starts),
              patch.object(updates.time, 'monotonic', side_effect=[0, 6]),
              self.assertRaisesRegex(ValueError, 'did not start')):
            updates.open_updates()
        self.assert_created_once()

    def test_targeting_stays_pinned_if_default_client_changes_after_discovery(self):
        self.pane()
        self.process(100)
        updates.open_updates()
        self.assertEqual([args for args, socket in self.targets if socket is None],
                         [('display-message', '-p', '#{socket_path}')])
        self.assertIn((('select-window', '-t', '@1'), SOCKET), self.targets)

    def test_registration_from_earlier_boot_or_reused_pid_is_not_an_owner(self):
        for key, value in [('boot_id', 'earlier-boot'), ('start', 'earlier-process')]:
            with self.subTest(key=key):
                self.rows, self.commands = [], []
                shutil.rmtree(self.proc, ignore_errors=True)
                shutil.rmtree(updates.STATE, ignore_errors=True)
                self.pane()
                self.process(100)
                path = updates.STATE / 'screens/100'
                record = json.loads(path.read_text())
                record[key] = value
                path.write_text(json.dumps(record))
                updates.open_updates()
                self.assert_created_once()

    def test_ssh_view_and_missing_client_fall_back_without_creating_request(self):
        with patch.dict(os.environ, {'SSH_CONNECTION': 'example'}):
            self.assertFalse(updates.open_updates(view=True))
        self.assertEqual(self.commands, [])
        with patch.object(updates, 'hn', side_effect=subprocess.CalledProcessError(1, 'hn')):
            self.assertFalse(updates.open_updates(view=True))
        self.request.assert_not_called()

    def test_valid_headless_socket_keeps_view_in_the_current_terminal(self):
        self.attached = False
        self.pane()
        self.process(100)
        self.assertFalse(updates.open_updates(view=True))
        self.request.assert_not_called()
        self.assertEqual(self.targets, [
            (('display-message', '-p', '#{socket_path}'), None),
            (('hn-list-clients', '-F', '#{client_tty}'), SOCKET)])


class UpdateEntryPoints(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.opener, self.python = self.root / 'opener', self.root / 'python'
        self.opener.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$OPENER_LOG"\nexit "$OPENER_EXIT"\n')
        self.python.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$PYTHON_LOG"\n')
        self.opener.chmod(0o755)
        self.python.chmod(0o755)
        self.wrapper = self.root / 'harness'
        source = SOURCE.parents[2] / 'bin/harness'
        self.wrapper.write_text(source.read_text().replace('/usr/lib/harness-os/open-updates', str(self.opener))
                                .replace('/usr/bin/python3', str(self.python)))
        self.env = dict(os.environ, OPENER_LOG=str(self.root / 'opener.log'),
                        PYTHON_LOG=str(self.root / 'python.log'), OPENER_EXIT='0')
        self.env.pop('SSH_CONNECTION', None)
        self.env.pop('SSH_TTY', None)

    def run_wrapper(self, *args, interactive=True):
        master, slave = os.openpty()
        try:
            result = subprocess.run(['/bin/sh', str(self.wrapper), 'updates', *args],
                                    stdin=slave if interactive else subprocess.DEVNULL,
                                    capture_output=True, env=self.env, timeout=5)
        finally:
            os.close(master)
            os.close(slave)
        return result

    def test_plain_and_screen_inspection_use_view_without_request(self):
        for args in [(), ('screen',)]:
            with self.subTest(args=args):
                self.assertEqual(self.run_wrapper(*args).returncode, 0)
                self.assertEqual((self.root / 'opener.log').read_text(), '--view\n')
                self.assertFalse((self.root / 'python.log').exists())

    def test_no_client_preserves_current_terminal_but_other_failure_does_not_duplicate_ui(self):
        self.env['OPENER_EXIT'] = '3'
        self.assertEqual(self.run_wrapper('screen').returncode, 0)
        self.assertEqual((self.root / 'python.log').read_text(), '/usr/lib/harness-os/live_update.py\nscreen\n')
        (self.root / 'python.log').unlink()
        self.env['OPENER_EXIT'] = '1'
        self.assertEqual(self.run_wrapper().returncode, 1)
        self.assertFalse((self.root / 'python.log').exists())

    def test_ssh_and_noninteractive_inspection_stays_in_current_terminal(self):
        for ssh in [False, True]:
            with self.subTest(ssh=ssh):
                if ssh:
                    self.env['SSH_CONNECTION'] = 'client server'
                self.assertEqual(self.run_wrapper(interactive=ssh).returncode, 0)
                self.assertFalse((self.root / 'opener.log').exists())
                self.assertEqual((self.root / 'python.log').read_text(), '/usr/lib/harness-os/live_update.py\n')

    def test_other_actions_and_explicit_developer_arguments_are_forwarded_unchanged(self):
        for args in [('check',), ('request',), ('apply',), ('rollback',), ('status',), ('screen', '--feeds', '/tmp/developer.json')]:
            with self.subTest(args=args):
                self.assertEqual(self.run_wrapper(*args).returncode, 0)
                self.assertFalse((self.root / 'opener.log').exists())
                self.assertEqual((self.root / 'python.log').read_text(), '/usr/lib/harness-os/live_update.py\n' + '\n'.join(args) + '\n')


if __name__ == '__main__':
    unittest.main()
