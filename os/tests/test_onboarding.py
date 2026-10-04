import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('onboarding', Path(__file__).resolve().parents[1] / 'onboarding.py')
onboarding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(onboarding)


def result(code=0):
    return subprocess.CompletedProcess([], code)


class Onboarding(unittest.TestCase):
    def test_network_page_opens_directly_then_agent_and_workspace_start(self):
        for live in [True, False]:
            with self.subTest(live=live), tempfile.TemporaryDirectory() as temp, \
                 patch.object(onboarding.Path, 'is_file', return_value=live), \
                 patch.object(onboarding.Path, 'home', return_value=Path(temp)), \
                 patch.object(onboarding.subprocess, 'run', return_value=result()) as command, \
                 patch.object(onboarding.os, 'execv') as execute, \
                 patch.dict(os.environ, {'TMUX_PANE': '%4'}):
                onboarding.welcome()
                self.assertEqual(command.call_args_list[0].args[0],
                                 ['sudo', '/usr/bin/python3', '/usr/lib/harness-os/network.py', '--first-use'])
                self.assertEqual(command.call_args_list[1].args[0], ['hn', 'os-action', 'ready', '%4'])
                execute.assert_called_once_with('/usr/bin/hn-os', ['hn-os', 'try'])
                self.assertEqual((Path(temp) / '.local/state/harness-os/onboarded').exists(), not live)

    def test_offline_install_opens_native_form_and_returns_to_network_page(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding.subprocess, 'run', side_effect=[result(10), result(), KeyboardInterrupt]) as command, \
             patch.object(onboarding.os, 'execv') as execute:
            with self.assertRaises(KeyboardInterrupt):
                onboarding.welcome()
            self.assertEqual(command.call_args_list[1].args[0], ['hn', 'os-action', 'install'])
            self.assertEqual(command.call_args_list[0], command.call_args_list[2])
            execute.assert_not_called()

    def test_installed_system_can_open_workspace_offline(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(onboarding.Path, 'is_file', return_value=False), \
             patch.object(onboarding.Path, 'home', return_value=Path(temp)), \
             patch.object(onboarding.subprocess, 'run', side_effect=[result(11), result()]), \
             patch.object(onboarding.os, 'execv') as execute:
            onboarding.welcome()
            execute.assert_called_once_with('/usr/bin/hn-os', ['hn-os', 'try', '--offline'])

    def test_failed_layout_request_does_not_mark_first_use_complete(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(onboarding.Path, 'is_file', return_value=False), \
             patch.object(onboarding.Path, 'home', return_value=Path(temp)), \
             patch.object(onboarding.subprocess, 'run', side_effect=[result(), subprocess.TimeoutExpired('hn', 15)]), \
             patch.object(onboarding.os, 'execv') as execute:
            onboarding.welcome()
            self.assertFalse((Path(temp) / '.local/state/harness-os/onboarded').exists())
            execute.assert_called_once()

    def test_install_launch_failure_keeps_network_recoverable(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding.subprocess, 'run', side_effect=[result(10), subprocess.TimeoutExpired('hn', 15), KeyboardInterrupt]) as command, \
             patch('builtins.input') as acknowledge, patch.object(onboarding.os, 'execv') as execute:
            with self.assertRaises(KeyboardInterrupt):
                onboarding.welcome()
            acknowledge.assert_called_once()
            self.assertEqual(command.call_args_list[0], command.call_args_list[2])
            execute.assert_not_called()
