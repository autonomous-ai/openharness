import importlib.machinery
import importlib.util
import json
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


class UpdatePaneOwnership(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / 'proc'
        self.rows, self.commands = [], []
        self.targets = []
        self.boot_id = self.root / 'boot-id'
        self.boot_id.write_text('first-boot')
        self.alias_pid = None
        for value in [patch.object(updates, 'PROC', self.proc),
                      patch.object(updates, 'BOOT_ID', self.boot_id),
                      patch.object(updates, 'STATE', self.root / 'state'),
                      patch.object(updates, 'hn', side_effect=self.hn),
                      patch.object(updates.subprocess, 'run')]:
            value.start()
            self.addCleanup(value.stop)
        self.request = updates.subprocess.run

    def process(self, pid, *, pane='%1', parent=1, group=10, foreground=10,
                command=None, children=(), state='S', start=123, socket=SOCKET, active=True):
        path = self.proc / str(pid)
        (path / 'task' / str(pid)).mkdir(parents=True, exist_ok=True)
        # /proc/stat's comm may contain spaces and parentheses; field 22 is the
        # process start time, not the PID or its command's human-readable name.
        fields = [state, str(parent), str(group), '10', '34816', str(foreground)] + ['0'] * 13 + [str(start)]
        (path / 'stat').write_text(f'{pid} (a test (process)) ' + ' '.join(fields))
        argv = command if command is not None else ['/usr/bin/python3', updates.UPDATER]
        (path / 'cmdline').write_bytes(b'\0'.join(word.encode() for word in argv) + b'\0')
        (path / 'environ').write_bytes(f'TMUX_PANE={pane}\0HN_SOCKET={socket}\0'.encode())
        (path / 'task' / str(pid) / 'children').write_text(' '.join(map(str, children)))
        screens = updates.STATE / 'screens'
        screens.mkdir(parents=True, exist_ok=True)
        if active:
            (screens / str(pid)).write_text(json.dumps(dict(
                pid=pid, start=str(start), pane=pane, socket=socket, boot_id='first-boot')))
        else:
            (screens / str(pid)).unlink(missing_ok=True)

    def pane(self, pane='%1', pid=100, dead='0', window='@1', socket=SOCKET):
        self.rows.append('\t'.join([pane, str(pid), dead, window, socket]))

    def hn(self, *args, socket=None):
        self.commands.append(args)
        self.targets.append((args, socket))
        if args == ('display-message', '-p', '#{socket_path}'):
            self.assertIsNone(socket)
            return SOCKET
        if args[0] == 'display-message':
            self.assertIsNotNone(socket)
            self.assertEqual(args[1:3], ('-p', '-t'))
            return str(self.alias_pid) if self.alias_pid is not None and args[3] == '%1' else next(
                (line.split('\t')[1] for line in self.rows if line.startswith(args[3] + '\t')), '')
        self.assertEqual(socket, SOCKET)
        if args[0] == 'list-panes':
            self.assertEqual(args, ('list-panes', '-s', '-F', updates.FORMAT))
            return '\n'.join(self.rows)
        if args[0] == 'new-window':
            self.assertEqual(args, ('new-window', '-P', '-F', '#{pane_id}', '-n', 'Updates',
                                    'exec /usr/bin/harness updates'))
            self.pane('%9', 900, window='@9')
            self.process(900, pane='%9')
            return '%9'
        self.assertIn(args[0], ['select-window', 'select-pane'])
        return ''

    def assert_created_once(self):
        self.assertEqual(sum(item[0] == 'new-window' for item in self.commands), 1)
        self.assertNotIn(('select-window', '-t', 'Updates'), self.commands)

    def test_an_unrelated_named_shell_cannot_swallow_the_request(self):
        self.pane()
        self.process(100, command=['/bin/bash'])
        updates.open_updates()
        self.assert_created_once()
        self.assertNotIn(('select-window', '-t', '@1'), self.commands)
        self.request.assert_called_once_with(['/usr/bin/harness', 'updates', 'request'], check=True, timeout=5)

    def test_a_live_updater_is_reused_by_ids_even_after_the_tab_is_renamed(self):
        self.pane()
        self.process(100)
        updates.open_updates()
        self.assertIn(('select-window', '-t', '@1'), self.commands)
        self.assertIn(('select-pane', '-t', '%1'), self.commands)
        self.assertFalse(any(item[0] == 'new-window' for item in self.commands))

    def test_manually_opened_updater_can_be_the_pane_shells_foreground_child(self):
        self.pane()
        self.process(100, command=['/bin/bash'], children=[101])
        self.process(101, parent=100, command=['/usr/bin/python3', updates.UPDATER, 'screen'])
        updates.open_updates()
        self.assertIn(('select-pane', '-t', '%1'), self.commands)
        self.assertFalse(any(item[0] == 'new-window' for item in self.commands))

    def test_missing_dead_zombie_background_and_foreign_processes_are_not_reused(self):
        for case in ['missing', 'dead', 'zombie', 'background', 'other-pane', 'wrong-alias', 'check', 'different-script', 'closed-screen']:
            with self.subTest(case=case):
                self.rows, self.commands = [], []
                shutil.rmtree(self.proc, ignore_errors=True)
                self.pane(dead='1' if case == 'dead' else '0')
                self.alias_pid = 999 if case == 'wrong-alias' else None
                if case != 'missing':
                    self.process(100, state='Z' if case == 'zombie' else 'S',
                                 foreground=20 if case == 'background' else 10,
                                 pane='%2' if case == 'other-pane' else '%1',
                                 active=case != 'closed-screen',
                                 command=['/usr/bin/python3', updates.UPDATER, 'check'] if case == 'check' else
                                         ['/usr/bin/python3', '/tmp/live_update.py'] if case == 'different-script' else None)
                updates.open_updates()
                self.assert_created_once()
                self.assertNotIn(('select-window', '-t', '@1'), self.commands)
                self.alias_pid = None

    def test_exiting_or_reused_process_during_selection_opens_a_fresh_updater(self):
        for case in ['exit', 'pid-reuse', 'pane-removed']:
            with self.subTest(case=case):
                self.rows, self.commands = [], []
                self.pane()
                self.process(100)
                def select(*args, **kwargs):
                    result = self.hn(*args, **kwargs)
                    if args[0] == 'select-pane':
                        if case == 'pid-reuse':
                            self.process(100, start=456)
                        else:
                            shutil.rmtree(self.proc / '100')
                        if case == 'pane-removed':
                            raise subprocess.CalledProcessError(1, 'hn')
                    return result
                with patch.object(updates, 'hn', side_effect=select):
                    updates.open_updates()
                self.assert_created_once()

    def test_rapid_shortcuts_wait_for_the_new_process_and_reuse_one_pane(self):
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
        self.assertEqual(self.commands, [])

    def test_startup_failure_is_bounded_and_does_not_create_more_panes(self):
        def never_starts(*args, **kwargs):
            result = self.hn(*args, **kwargs)
            return '' if args[0] == 'list-panes' else result
        with (patch.object(updates, 'hn', side_effect=never_starts),
              patch.object(updates.time, 'monotonic', side_effect=[0, 6]),
              self.assertRaisesRegex(ValueError, 'did not start')):
            updates.open_updates()
        self.assert_created_once()

    def test_surviving_primary_alias_is_resolved_to_the_actual_pane_process(self):
        self.pane()
        self.process(100, socket='/run/user/1000/hn/primary.sock')
        updates.open_updates()
        self.assertIn((('display-message', '-p', '-t', '%1', '#{pane_pid}'),
                       '/run/user/1000/hn/primary.sock'), self.targets)
        self.assertIn((('select-pane', '-t', '%1'), SOCKET), self.targets)
        self.assertFalse(any(item[0] == 'new-window' for item in self.commands))

    def test_targeting_stays_pinned_if_the_default_client_changes_after_discovery(self):
        self.pane()
        self.process(100)
        updates.open_updates()
        unpinned = [args for args, socket in self.targets if socket is None]
        self.assertEqual(unpinned, [('display-message', '-p', '#{socket_path}')])
        self.assertIn((('select-window', '-t', '@1'), SOCKET), self.targets)

    def test_registration_from_an_earlier_boot_or_reused_pid_is_not_an_owner(self):
        for key, value in [('boot_id', 'earlier-boot'), ('start', 'earlier-process')]:
            with self.subTest(key=key):
                self.rows, self.commands = [], []
                self.pane()
                self.process(100)
                path = updates.STATE / 'screens/100'
                record = json.loads(path.read_text())
                record[key] = value
                path.write_text(json.dumps(record))
                updates.open_updates()
                self.assert_created_once()
