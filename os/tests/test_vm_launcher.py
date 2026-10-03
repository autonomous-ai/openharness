import contextlib
import importlib.util
import io
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location('vm_launcher', Path(__file__).parents[1] / 'tools/run-vm.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class RemoteLauncher(unittest.TestCase):
    def test_invalid_endpoints_fail_before_any_vm_is_created(self):
        for flags in [
            ['--vnc-port', '5899'], ['--vnc-port', '65536'],
            ['--ssh-port', '22'], ['--ssh-port', '65536'],
            ['--vnc-port', '5900', '--ssh-port', '5900'],
            ['--remote-host', 'vm.example'],
            ['--vnc-port', '5900', '--remote-host=-oProxyCommand=bad'],
            ['--vnc-port', '5900', '--remote-host', 'vm; echo bad'],
        ]:
            with self.subTest(flags=flags), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                launcher.arguments(flags)

    def test_services_are_loopback_only_and_the_tunnel_matches_both(self):
        _, args = launcher.arguments(['--vnc-port', '5901', '--ssh-port', '2222', '--remote-host', 'me@vm.example'])
        options = launcher.remote_options(args)
        self.assertIn('127.0.0.1:1', options)
        self.assertIn('user,id=net,hostfwd=tcp:127.0.0.1:2222-:22', options)
        command = shlex.split(launcher.connection_help(args)[1])
        self.assertEqual(command[-1], 'me@vm.example')
        self.assertIn('127.0.0.1:5901:127.0.0.1:5901', command)
        self.assertIn('127.0.0.1:2222:127.0.0.1:2222', command)
        self.assertIn('ExitOnForwardFailure=yes', command)

    def test_default_launch_has_no_remote_listeners(self):
        _, args = launcher.arguments([])
        self.assertEqual(launcher.remote_options(args), ['-netdev', 'user,id=net'])
        self.assertEqual(launcher.connection_help(args), [])

    def test_acceleration_required_refuses_emulation_before_touching_the_disk(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'new-vm'
            with patch.object(launcher.shutil, 'which', return_value='/qemu'), \
                    patch.object(launcher, 'acceleration', return_value='tcg'), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                launcher.main(['--installed', '--directory', str(directory), '--require-acceleration'])
            self.assertFalse(directory.exists())


if __name__ == '__main__':
    unittest.main()
