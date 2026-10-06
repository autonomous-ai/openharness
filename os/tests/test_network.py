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
        self.size, self.frames, self.current = (24, 80), [], []
    def keypad(self, value): pass
    def timeout(self, value): pass
    def refresh(self): self.frames.append(list(self.current))
    def erase(self): self.current = []
    def move(self, *args): pass
    def getmaxyx(self): return self.size
    def get_wch(self): return next(self.keys)
    def addnstr(self, row, column, text, width, style):
        assert 0 <= row < self.size[0] and 0 <= column < self.size[1] and column + width < self.size[1]
        self.lines.append((row, text.rstrip()))
        self.current.append((row, column, text, style))


class Network(unittest.TestCase):
    def test_privileged_form_uses_a_fixed_executable_not_the_callers_path(self):
        with patch.object(network.subprocess, 'run', return_value=result()) as run:
            network.nmcli('general')
        self.assertEqual(run.call_args.args[0][0], '/usr/bin/nmcli')

    def test_unavailable_ethernet_remains_selectable_for_explicit_reconnection(self):
        devices = ('lo:loopback:connected (externally)\nens5:ethernet:unavailable\n'
                   'eth1:ethernet:disconnected\nwlan0:wifi:unavailable\n')
        with patch.object(network, 'nmcli', return_value=result(output=devices)):
            self.assertEqual(network.wired_devices(), [
                ['ens5', 'ethernet', 'unavailable'], ['eth1', 'ethernet', 'disconnected']])

    def test_ethernet_waits_for_availability_before_selecting_a_profile(self):
        with patch.object(network.subprocess, 'run', return_value=result()) as link, \
             patch.object(network, 'nmcli', side_effect=[result(output='20 (unavailable)'),
                 result(output='30 (disconnected)'), result()]) as command, \
             patch.object(network.time, 'sleep'):
            self.assertTrue(network.connect_wired('ens5', 'unavailable'))
        self.assertEqual(link.call_args.args[0], ['/usr/bin/ip', 'link', 'set', 'dev', 'ens5', 'up'])
        self.assertEqual([call.args for call in command.call_args_list], [
            ('-g', 'GENERAL.STATE', 'device', 'show', 'ens5'),
            ('-g', 'GENERAL.STATE', 'device', 'show', 'ens5'),
            ('device', 'connect', 'ens5')])

    def test_ethernet_does_not_interrupt_automatic_reconnection(self):
        with patch.object(network.subprocess, 'run', return_value=result()), \
             patch.object(network, 'nmcli', side_effect=[result(output='70 (connecting)'),
                 result(output='100 (connected)')]) as command, patch.object(network.time, 'sleep'):
            self.assertTrue(network.connect_wired('ens5', 'unavailable'))
        self.assertFalse(any(call.args[:2] == ('device', 'connect') for call in command.call_args_list))

    def test_ethernet_does_not_create_a_profile_when_the_link_stays_unavailable(self):
        with patch.object(network.subprocess, 'run', return_value=result()), \
             patch.object(network, 'nmcli', return_value=result(output='20 (unavailable)')) as command, \
             patch.object(network.time, 'monotonic', side_effect=[0, 11]):
            self.assertFalse(network.connect_wired('ens5', 'unavailable'))
        command.assert_called_once_with('-g', 'GENERAL.STATE', 'device', 'show', 'ens5', wait=2)

    def test_ethernet_link_failure_stops_before_activation(self):
        with patch.object(network.subprocess, 'run', return_value=result(1)), \
             patch.object(network, 'nmcli') as command:
            self.assertFalse(network.connect_wired('ens5', 'unavailable'))
        command.assert_not_called()

    def test_disconnected_ethernet_keeps_normal_networkmanager_selection(self):
        with patch.object(network.subprocess, 'run') as link, \
             patch.object(network, 'nmcli', return_value=result()) as command:
            self.assertTrue(network.connect_wired('ens5', 'disconnected'))
        link.assert_not_called()
        command.assert_called_once_with('device', 'connect', 'ens5', wait=30)

    def test_scans_escape_ssids_and_deduplicate_radios_without_hiding_open_networks(self):
        rows = 'a\\:network:60:WPA2:wlan0:aa\\:bb:\nopen:90:--:wlan0:bb\\:cc:\na\\:network:88:WPA2:wlan0:cc\\:dd:*\n:80:WPA2:wlan0:dd\\:ee:\n'
        with patch.object(network, 'nmcli', return_value=result(output=rows)):
            found = network.scan()
        self.assertEqual([n['ssid'] for n in found], ['a:network', 'open'])
        self.assertEqual(found[0]['signal'], 88)
        self.assertEqual(found[0]['bssid'], 'cc:dd')

    def test_opening_wifi_uses_recent_scan_when_forced_rescan_would_stall(self):
        def command(*args, **kwargs):
            if args[-2:] == ('--rescan', 'yes'):
                raise subprocess.TimeoutExpired('nmcli', 13)
            return result(output='a\\:network:88:WPA2:wlan0:cc\\:dd:*\n')
        with patch.object(network, 'nmcli', side_effect=command):
            found = network.scan()
        self.assertEqual(found[0]['ssid'], WIFI['ssid'])
        self.assertTrue(found[0]['active'])

    def test_explicit_rescan_still_requests_a_new_radio_scan(self):
        real_scan = network.scan
        screen, page = self.page(['r', '\x1b'], first_use=False)
        modes = []
        def command(*args, **kwargs):
            if '--rescan' in args:
                modes.append(args[args.index('--rescan') + 1])
                return result(output='a\\:network:88:WPA2:wlan0:cc\\:dd:*\n')
            return result()
        with patch.object(network, 'scan', side_effect=real_scan), patch.object(network, 'nmcli', side_effect=command):
            self.assertEqual(page.run(), 1)
        self.assertEqual(modes, ['auto', 'yes'])

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

    def page(self, keys, first_use=True):
        screen = Screen(keys)
        self.enterContext(patch.object(network.curses, 'curs_set'))
        self.enterContext(patch.object(network, 'connected', return_value=False))
        self.enterContext(patch.object(network, 'scan', return_value=[WIFI]))
        self.enterContext(patch.object(network, 'wired_devices', return_value=[['eth0', 'ethernet', 'disconnected']]))
        self.enterContext(patch.object(network, 'nmcli', return_value=result()))
        return screen, network.NetworkPage(screen, first_use=first_use)

    def test_first_page_keeps_wifi_above_wired_and_advances_only_after_connection(self):
        screen, page = self.page(['\x1b', '\x03', 'r', '\n'])
        with patch.object(network, 'connect', return_value=True):
            self.assertEqual(page.run(), 0)
        text = '\n'.join(text for _, text in screen.lines)
        self.assertIn('Connect to Wi-Fi', text)
        self.assertNotIn('The operating system', text)
        self.assertLess(text.index('a:network'), text.index('Ethernet'))
        self.assertIn('Rescan', text)
        self.assertNotIn('Install without connecting', text)
        self.assertNotIn('Set up later', text)
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

    def test_connected_site_or_local_network_skips_setup_without_an_internet_probe(self):
        for state, expected in [('connected', True), ('connected (site only)', True),
                                ('connected (local only)', True), ('connecting', False),
                                ('disconnected', False), ('asleep', False)]:
            with self.subTest(state=state), patch.object(network, 'nmcli', return_value=result(output=state)):
                self.assertEqual(network.connected(), expected)

    def test_working_ethernet_skips_the_form(self):
        screen, page = self.page([])
        with patch.object(network, 'connected', return_value=True), patch.object(network, 'scan') as scan:
            self.assertEqual(page.run(), 0)
            scan.assert_not_called()

    def test_crowded_scan_scrolls_to_last_network_and_keeps_rescan_reachable(self):
        for size in [(24, 54), (45, 160)]:
            screen, page = self.page([], first_use=False)
            screen.size = size
            networks = [dict(WIFI, ssid=f'network-{i:02}') for i in range(23)]
            # Move to the last network, escape its password, then close the
            # on-demand form. Rescan remains visible while the list scrolls.
            screen.keys = iter([curses.KEY_DOWN] * 22 + ['\n', '\x1b', '\x1b'])
            with patch.object(network, 'scan', return_value=networks), patch.object(network, 'connect', return_value=False) as connect:
                self.assertEqual(page.run(), 1)
                self.assertEqual(connect.call_args.args[0]['ssid'], 'network-22')
            for frame in screen.frames:
                names = [text for _, _, text, _ in frame if text.startswith('network-')]
                self.assertLessEqual(len(names), 10)
                if names:
                    self.assertTrue(any('Rescan' in text for _, _, text, _ in frame))

    def test_open_network_failure_does_not_ask_for_a_nonexistent_password(self):
        screen, page = self.page(['\n', '\x1b'], first_use=False)
        with patch.object(network, 'scan', return_value=[dict(WIFI, security='--')]), \
             patch.object(network, 'connect', return_value=False), patch.object(page, 'password') as password:
            self.assertEqual(page.run(), 1)
            password.assert_not_called()

    def test_selected_connected_row_reconnects_when_link_dropped_after_scan(self):
        screen, page = self.page(['\n'], first_use=False)
        active = dict(WIFI, active=True)
        with patch.object(network, 'scan', side_effect=[[active], [WIFI]]) as scan, \
             patch.object(network, 'connect', return_value=True) as connect:
            self.assertEqual(page.run(), 0)
            connect.assert_called_once_with(active)
            self.assertEqual(scan.call_args.kwargs, {'rescan': False})

    def test_selecting_current_connection_does_not_interrupt_work(self):
        screen, page = self.page(['\n'], first_use=False)
        with patch.object(network, 'scan', return_value=[dict(WIFI, active=True)]) as scan, \
             patch.object(network, 'connect') as connect:
            self.assertEqual(page.run(), 0)
            connect.assert_not_called()
            self.assertEqual(scan.call_count, 2)
            self.assertEqual(scan.call_args.kwargs, {'rescan': False})

    def test_same_ssid_on_another_radio_is_not_the_selected_connection(self):
        screen, page = self.page(['\n'], first_use=False)
        active = dict(WIFI, active=True)
        other = dict(active, device='wlan1')
        with patch.object(network, 'scan', side_effect=[[active], [other]]), \
             patch.object(network, 'connect', return_value=True) as connect:
            self.assertEqual(page.run(), 0)
            connect.assert_called_once_with(active)

    def test_wifi_scan_error_does_not_hide_ethernet_or_keep_stale_rows(self):
        screen, page = self.page([], first_use=False)
        with patch.object(network, 'scan', side_effect=[[WIFI], ValueError('Could not scan Wi-Fi.')]):
            page.refresh()
            self.assertEqual(page.networks, [WIFI])
            page.refresh()
        self.assertEqual(page.networks, [])
        self.assertEqual(page.wired, [['eth0', 'ethernet', 'disconnected']])
        self.assertEqual(page.message, 'Could not scan Wi-Fi.')

    def test_ethernet_is_usable_when_wifi_scan_fails(self):
        screen, page = self.page([curses.KEY_DOWN, '\n'])
        with patch.object(network, 'scan', side_effect=ValueError('Could not scan Wi-Fi.')), \
             patch.object(network, 'nmcli', return_value=result()) as command:
            self.assertEqual(page.run(), 0)
        self.assertEqual(command.call_args.args, ('device', 'connect', 'eth0'))

    def test_failed_ethernet_reconnection_keeps_the_network_page_open(self):
        screen, page = self.page([curses.KEY_DOWN, '\n', '\x1b'], first_use=False)
        with patch.object(network, 'scan', return_value=[]), \
             patch.object(network, 'wired_devices', return_value=[['ens5', 'ethernet', 'unavailable']]), \
             patch.object(network, 'connect_wired', return_value=False) as connect, \
             patch.object(network, 'nmcli') as command:
            self.assertEqual(page.run(), 1)
        connect.assert_called_once_with('ens5', 'unavailable')
        self.assertIn('Could not connect Ethernet.', '\n'.join(text for _, text in screen.lines))
        self.assertFalse(any(call.args[:2] == ('connection', 'delete') for call in command.call_args_list))

    def test_wide_and_control_characters_fit_the_terminal(self):
        self.assertEqual(network.fit('網路123', 5), '網路1')
        self.assertEqual(network.fit('a\x1b\tb', 6), 'a  b  ')
