import curses
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('network', Path(__file__).resolve().parents[1] / 'network.py')
network = importlib.util.module_from_spec(spec)
spec.loader.exec_module(network)


def result(code=0, output=''):
    return subprocess.CompletedProcess([], code, output, '')


WIFI = dict(ssid='a:network', device='wlan0', security='WPA2', active=False, signal=88)


class Screen:
    def __init__(self, keys):
        self.keys, self.lines = iter(keys), []
    def keypad(self, value): pass
    def timeout(self, value): pass
    def refresh(self): pass
    def erase(self): pass
    def move(self, *args): pass
    def getmaxyx(self): return 24, 80
    def get_wch(self): return next(self.keys)
    def addnstr(self, row, column, text, width, style): self.lines.append((row, text.rstrip()))


class Network(unittest.TestCase):
    def test_scans_escape_ssids_and_deduplicate_radios_without_hiding_open_networks(self):
        rows = 'a\\:network:60:WPA2:wlan0:aa\\:bb:\nopen:90:--:wlan0:bb\\:cc:\na\\:network:88:WPA2:wlan0:cc\\:dd:*\n:80:WPA2:wlan0:dd\\:ee:\n'
        with patch.object(network, 'nmcli', return_value=result(output=rows)):
            found = network.scan()
        self.assertEqual([n['ssid'] for n in found], ['a:network', 'open'])
        self.assertEqual(found[0]['signal'], 88)
        self.assertEqual(found[0]['bssid'], 'cc:dd')

    def test_password_is_only_passed_on_stdin_and_only_success_enables_reconnect(self):
        calls = []
        def run(*args, **kwargs):
            calls.append((args, kwargs))
            return result()
        with patch.object(network, 'nmcli', side_effect=run):
            self.assertTrue(network.connect(WIFI, 'secret:with spaces'))
        self.assertNotIn('secret:with spaces', repr([args for args, _ in calls]))
        self.assertEqual(calls[1][1]['secret'], '802-11-wireless-security.psk:secret:with spaces\n')
        self.assertEqual(calls[-1][0][-2:], ('connection.autoconnect', 'yes'))
        self.assertFalse(any('delete' in args for args, _ in calls))

    def test_bad_password_deletes_only_the_profile_created_by_that_attempt(self):
        with patch.object(network, 'nmcli', side_effect=[result(), result(4), result()]) as command:
            self.assertFalse(network.connect(WIFI, 'wrong-password'))
        identity = command.call_args_list[0].args[command.call_args_list[0].args.index('connection.uuid') + 1]
        self.assertEqual(command.call_args_list[-1].args, ('connection', 'delete', 'uuid', identity))

    def test_saved_profile_reconnect_does_not_replace_or_delete_it(self):
        with patch.object(network, 'saved_connection', return_value='existing'), \
             patch.object(network, 'nmcli', return_value=result(4)) as command:
            self.assertFalse(network.connect(WIFI))
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args, ('connection', 'up', 'uuid', 'existing', 'ifname', 'wlan0'))

    def page(self, keys, live=True):
        screen = Screen(keys)
        self.enterContext(patch.object(network.curses, 'curs_set'))
        self.enterContext(patch.object(network, 'connected', return_value=False))
        self.enterContext(patch.object(network, 'scan', return_value=[WIFI]))
        self.enterContext(patch.object(network, 'wired_devices', return_value=[['eth0', 'ethernet', 'disconnected']]))
        self.enterContext(patch.object(network, 'nmcli', return_value=result()))
        return screen, network.NetworkPage(screen, first_use=True, live=live)

    def test_first_page_has_wifi_above_wired_rescan_and_always_visible_offline_install(self):
        screen, page = self.page(['\x1b', 'r', 'i'])
        self.assertEqual(page.run(), network.INSTALL)
        text = '\n'.join(text for _, text in screen.lines)
        self.assertIn('Welcome to Harness', text)
        self.assertLess(text.index('a:network'), text.index('Ethernet'))
        self.assertIn('Rescan', text)
        self.assertIn('Install without connecting', text)
        self.assertNotIn('Quit', text)
        self.assertNotIn('Activate', text)

    def test_password_retry_is_masked_and_success_advances_without_quit(self):
        screen, page = self.page(['\n', *'wrong-password', '\n', *'right-password', '\n'])
        with patch.object(network, 'connect', side_effect=[False, False, True]):
            self.assertEqual(page.run(), 0)
        text = '\n'.join(text for _, text in screen.lines)
        self.assertIn('Check the password', text)
        self.assertNotIn('wrong-password', text)
        self.assertNotIn('right-password', text)
        self.assertIn('*****', text)

    def test_working_ethernet_skips_the_form(self):
        screen, page = self.page([])
        with patch.object(network, 'connected', return_value=True), patch.object(network, 'scan') as scan:
            self.assertEqual(page.run(), 0)
            scan.assert_not_called()

    def test_open_network_failure_does_not_ask_for_a_nonexistent_password(self):
        screen, page = self.page(['\n', 'i'])
        with patch.object(network, 'scan', return_value=[dict(WIFI, security='--')]), \
             patch.object(network, 'connect', return_value=False), patch.object(page, 'password') as password:
            self.assertEqual(page.run(), network.INSTALL)
            password.assert_not_called()

    def test_wide_and_control_characters_fit_the_terminal(self):
        self.assertEqual(network.fit('網路123', 5), '網路1')
        self.assertEqual(network.fit('a\x1b\tb', 6), 'a  b  ')
