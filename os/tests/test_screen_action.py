import importlib.machinery
import importlib.util
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / 'root'
SOURCE = ROOT / 'usr/lib/harness-os/screen-action'
loader = importlib.machinery.SourceFileLoader('screen_action', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
screen = importlib.util.module_from_spec(spec)
loader.exec_module(screen)


class ScreenRouting(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.proc = self.root / 'proc'
        self.base = self.root / 'sockets'
        self.peers = {}
        for value in (patch.object(screen, 'PROC', self.proc),
                      patch.object(screen.subprocess, 'check_output', return_value='10\n'),
                      patch.object(screen, 'peer_pid', side_effect=lambda path: self.peers.get(str(path))),
                      patch.dict(os.environ, {}, clear=True), patch.object(screen.os, 'execve')):
            value.start()
            self.addCleanup(value.stop)
        self.make_process(10, 1, tty=0)
        self.make_process(20, 10)
        self.children(20)
        self.primary = self.endpoint('default.sock')
        self.attached = self.endpoint('default@20.sock')

    def endpoint(self, name):
        return str(self.base / ('hn-' + str(os.getuid())) / name)

    def make_process(self, pid, parent, *, tty=34816, foreground=None, start=100, state='S', env=None):
        path = self.proc / str(pid)
        path.mkdir(parents=True, exist_ok=True)
        fields = [state, str(parent), str(pid), '10', str(tty), str(pid if foreground is None else foreground)]
        (path / 'stat').write_text(f'{pid} (test (process)) ' + ' '.join(fields + ['0'] * 13 + [str(start)]))
        environment = {'HARNESS_OS': '1', 'HN_TMPDIR': str(self.base)} if env is None else env
        (path / 'environ').write_text('\0'.join(k+'='+v for k,v in environment.items())+'\0')

    def children(self, *pids):
        task = self.proc / '10/task/10'
        task.mkdir(parents=True, exist_ok=True)
        (task / 'children').write_text(' '.join(str(pid) for pid in pids))

    def test_first_screen_uses_its_primary_socket(self):
        self.peers[self.primary] = 20
        self.assertEqual(screen.screen_socket(), self.primary)

    def test_retained_headless_primary_cannot_take_the_visible_shortcut(self):
        self.peers[self.primary] = 30
        self.peers[self.attached] = 20
        self.make_process(30, 1, tty=0)
        self.assertEqual(screen.screen_socket(), self.attached)

    def test_inherited_shell_socket_does_not_redirect_a_compositor_action(self):
        self.peers[self.primary] = 30
        self.peers[self.attached] = 20
        with patch.dict(os.environ, HN_SOCKET=self.primary, TMUX=self.primary+',30,0'):
            screen.dispatch('terminal')
        command, arguments, environment = screen.os.execve.call_args.args
        self.assertEqual(arguments, ['/usr/bin/hn', '-S', self.attached, 'os-action', 'terminal'])
        self.assertEqual(command, arguments[0])
        self.assertEqual(environment['HN_SOCKET'], self.attached)

    def test_update_opener_inherits_the_exact_visible_socket(self):
        self.peers[self.attached] = 20
        screen.dispatch('updates')
        command, arguments, environment = screen.os.execve.call_args.args
        self.assertEqual(arguments, ['/usr/lib/harness-os/open-updates'])
        self.assertEqual(command, arguments[0])
        self.assertEqual(environment['HN_SOCKET'], self.attached)

    def test_no_fallback_to_a_headless_or_unrelated_client(self):
        self.peers[self.primary] = 30
        self.peers[self.attached] = 30  # stale path now owned by a different process
        with self.assertRaisesRegex(RuntimeError, 'reconnecting'):
            screen.dispatch('terminal')
        screen.os.execve.assert_not_called()

    def test_background_dead_or_non_os_children_are_not_screens(self):
        self.peers[self.attached] = 20
        for options in ({'tty':0}, {'foreground':30}, {'state':'Z'}, {'env':{}}, {'parent':30}):
            with self.subTest(options=options):
                arguments = dict(parent=10)
                arguments.update(options)
                self.make_process(20, **arguments)
                with self.assertRaises(RuntimeError):
                    screen.screen_socket()

    def test_multiple_eligible_children_are_ambiguous(self):
        self.make_process(21, 10)
        self.children(20,21)
        self.peers[self.attached] = 20
        self.peers[self.endpoint('default@21.sock')] = 21
        with self.assertRaises(RuntimeError):
            screen.screen_socket()

    def test_screen_restart_during_lookup_does_not_dispatch(self):
        self.peers[self.attached] = 20
        original = screen.peer_pid
        def restart(path):
            self.make_process(10, 1, tty=0, start=200)
            return original(path)
        with patch.object(screen, 'peer_pid', side_effect=restart):
            with self.assertRaises(RuntimeError):
                screen.dispatch('wifi')
        screen.os.execve.assert_not_called()

    def test_stopped_service_and_unknown_action_do_not_run_commands(self):
        with patch.object(screen.subprocess,'check_output',return_value='0\n'):
            with self.assertRaises(RuntimeError):
                screen.dispatch('new')
        with self.assertRaises(ValueError):
            screen.dispatch('arbitrary-command')
        screen.os.execve.assert_not_called()

    def test_named_socket_uses_the_screen_process_environment(self):
        self.make_process(20, 10, env={'HARNESS_OS':'1', 'HN_SOCKET_NAME':'my-screen',
                                     'TMUX_TMPDIR':str(self.base)})
        named = self.endpoint('my-screen@20.sock')
        self.peers[named] = 20
        self.assertEqual(screen.screen_socket(), named)


class ShortcutBindings(unittest.TestCase):
    def test_compositor_actions_share_the_foreground_router(self):
        tree = ET.parse(ROOT / 'usr/share/harness-os/labwc/rc.xml')
        commands = {key.get('key'): [a.get('command') for a in key.findall('.//action') if a.get('name')=='Execute']
                    for key in tree.findall('.//keybind')}
        for key, action in [('W-n','new'),('W-t','terminal'),('W-m','connect'),('W-u','updates')]:
            self.assertEqual(commands[key], ['/usr/lib/harness-os/screen-action '+action])
        self.assertEqual(commands['W-w'], ['/usr/lib/harness-os/open-wifi'])
        self.assertIn('exec /usr/lib/harness-os/screen-action wifi', (ROOT / 'usr/lib/harness-os/open-wifi').read_text())

    @unittest.skipUnless(hasattr(socket, 'SO_PEERCRED'), 'Linux peer credentials')
    def test_linux_peer_identity_and_missing_socket(self):
        with tempfile.TemporaryDirectory(prefix='hn-socket-', dir='/tmp') as folder:
            path=Path(folder)/'owned.sock'
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as listener:
                listener.bind(str(path));listener.listen()
                self.assertEqual(screen.peer_pid(path), os.getpid())
            self.assertIsNone(screen.peer_pid(path))
