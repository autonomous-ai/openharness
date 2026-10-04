import importlib.util
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('onboarding', Path(__file__).resolve().parents[1] / 'onboarding.py')
onboarding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(onboarding)


class Onboarding(unittest.TestCase):
    def test_ethernet_skips_network_form_and_starts_the_real_agent(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding, 'connected', return_value=True), \
             patch.object(onboarding.curses, 'set_escdelay'), \
             patch.object(onboarding.curses, 'wrapper') as form, \
             patch.object(onboarding.subprocess, 'run') as command, \
             patch.object(onboarding.os, 'execv') as execute, \
             patch.dict(os.environ, {'TMUX_PANE': '%4'}):
            onboarding.welcome()
            form.assert_not_called()
            command.assert_called_once_with(['hn', 'os-action', 'ready', '%4'], check=False, timeout=15)
            execute.assert_called_once_with('/usr/bin/hn-os', ['hn-os', 'try'])

    def test_offline_install_opens_native_form_without_starting_an_agent(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding, 'connected', return_value=False), \
             patch.object(onboarding.curses, 'set_escdelay'), \
             patch.object(onboarding.curses, 'wrapper', side_effect=['install', KeyboardInterrupt]), \
             patch.object(onboarding.subprocess, 'run') as command, \
             patch.object(onboarding.os, 'execv') as execute:
            with self.assertRaises(KeyboardInterrupt):
                onboarding.welcome()
            command.assert_called_once_with(['hn', 'os-action', 'install'], check=True, timeout=15)
            execute.assert_not_called()

    def test_cancelled_wifi_returns_to_network_form(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding, 'connected', return_value=False), \
             patch.object(onboarding.curses, 'set_escdelay'), \
             patch.object(onboarding.curses, 'wrapper', side_effect=['wifi', KeyboardInterrupt]) as form, \
             patch.object(onboarding.subprocess, 'run') as command, \
             patch.object(onboarding.os, 'execv') as execute:
            with self.assertRaises(KeyboardInterrupt):
                onboarding.welcome()
            self.assertEqual(form.call_count, 2)
            command.assert_called_once_with(['/usr/bin/hn-os', 'wifi'], check=False)
            execute.assert_not_called()

    def test_network_failure_stays_recoverable_and_installed_system_rejects_usb_flow(self):
        for failure in [OSError('missing'), subprocess.TimeoutExpired('nmcli', 3)]:
            with patch.object(onboarding.subprocess, 'run', side_effect=failure):
                self.assertFalse(onboarding.connected())
        with patch.object(onboarding.Path, 'is_file', return_value=False), \
             patch.object(onboarding, 'connected') as connected:
            with self.assertRaises(SystemExit):
                onboarding.welcome()
            connected.assert_not_called()

    def test_install_launch_failure_keeps_a_recoverable_network_screen(self):
        with patch.object(onboarding.Path, 'is_file', return_value=True), \
             patch.object(onboarding, 'connected', return_value=False), \
             patch.object(onboarding.curses, 'set_escdelay'), \
             patch.object(onboarding.curses, 'wrapper', side_effect=['install', KeyboardInterrupt]) as form, \
             patch.object(onboarding.subprocess, 'run', side_effect=subprocess.TimeoutExpired('hn', 15)), \
             patch.object(onboarding.os, 'execv') as execute:
            with self.assertRaises(KeyboardInterrupt):
                onboarding.welcome()
            self.assertIn('Could not open Install', form.call_args.args[1])
            execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
