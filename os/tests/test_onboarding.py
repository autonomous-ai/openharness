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
    def test_installed_network_page_advances_to_agent_and_workspace(self):
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(onboarding.Path, 'is_file', return_value=False), \
             patch.object(onboarding.Path, 'home', return_value=Path(temp)), \
             patch.object(onboarding.subprocess, 'run', return_value=result()) as command, \
             patch.object(onboarding.os, 'execv') as execute, \
             patch.dict(os.environ, {'TMUX_PANE': '%4'}):
            onboarding.welcome()
            self.assertEqual(command.call_args_list[0].args[0],
                             ['sudo', '/usr/bin/python3', '/usr/lib/harness-os/network.py', '--first-use'])
            self.assertEqual(command.call_args_list[1].args[0], ['hn', 'os-action', 'ready', '%4'])
            execute.assert_called_once_with('/usr/bin/hn-os', ['hn-os', 'try'])
            self.assertTrue((Path(temp) / '.local/state/harness-os/onboarded').exists())

    def test_usb_never_opens_networking_or_an_agent(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding.subprocess, 'run') as command, \
             patch.object(onboarding.os, 'execv') as execute:
            onboarding.welcome()
            command.assert_not_called()
            execute.assert_called_once_with('/usr/lib/harness-os/open-install', ['open-install'])

    def test_failed_layout_request_does_not_mark_first_use_complete(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(onboarding.Path, 'is_file', return_value=False), \
             patch.object(onboarding.Path, 'home', return_value=Path(temp)), \
             patch.object(onboarding.subprocess, 'run', side_effect=[result(), subprocess.TimeoutExpired('hn', 15)]), \
             patch.object(onboarding.os, 'execv') as execute:
            onboarding.welcome()
            self.assertFalse((Path(temp) / '.local/state/harness-os/onboarded').exists())
            execute.assert_called_once()

    def test_network_failure_does_not_claim_onboarding_or_start_agent(self):
        with patch.object(onboarding.Path, 'is_file', return_value=False), \
             patch.object(onboarding.subprocess, 'run', return_value=result(1)), \
             patch.object(onboarding.os, 'execv') as execute:
            with self.assertRaisesRegex(SystemExit, 'Could not open Wi-Fi'):
                onboarding.welcome()
            execute.assert_not_called()
