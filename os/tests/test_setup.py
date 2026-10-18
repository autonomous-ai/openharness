import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('setup', Path(__file__).resolve().parents[1] / 'setup.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


def result(code=0, output='', error=''):
    return subprocess.CompletedProcess([], code, output, error)


class Requests(unittest.TestCase):
    def test_a_wifi_and_ticket_pass(self):
        self.assertIsNone(setup.check_request(dict(ssid='Glink 1', password='@11235813', ticket='t')))
        self.assertIsNone(setup.check_request(dict(ssid='Cafe')))
        self.assertIsNone(setup.check_request(dict(ssid='Cafe', password='')))

    def test_what_a_wifi_cannot_take_is_refused_before_leaving_the_hotspot(self):
        self.assertEqual(setup.check_request([]), 'Send a JSON object.')
        self.assertEqual(setup.check_request(dict(ssid='')), 'Choose a Wi-Fi network.')
        self.assertEqual(setup.check_request(dict(ssid='x' * 33)), 'Choose a Wi-Fi network.')
        self.assertEqual(setup.check_request(dict(ssid='a', password='short')), 'A Wi-Fi password has 8 to 63 characters.')
        self.assertEqual(setup.check_request(dict(ssid='a', password='x' * 64)), 'A Wi-Fi password has 8 to 63 characters.')
        self.assertEqual(setup.check_request(dict(ssid='a', password='two\nlines')), 'That Wi-Fi password cannot be used.')
        self.assertEqual(setup.check_request(dict(ssid='a', ticket='bad\x00')), 'That sign-in ticket cannot be used.')


class Reasons(unittest.TestCase):
    def test_network_manager_failures_become_what_the_person_can_fix(self):
        cases = {
            'Error: Connection activation failed: Secrets were required, but not provided.': 'WRONG_PASSWORD',
            'Error: Connection activation failed: (7) no-secrets': 'WRONG_PASSWORD',
            'Error: Connection activation failed: The Wi-Fi network could not be found': 'NOT_FOUND',
            'Error: No network with SSID \'x\' found.': 'NOT_FOUND',
            'Error: Connection activation failed: IP configuration could not be reserved': 'NO_ADDRESS',
            'Error: Timeout expired (45 seconds)': 'TIMEOUT',
            'Error: something else': 'WIFI',
        }
        for output, expected in cases.items():
            self.assertEqual(setup.reason(output), expected, output)


class Connect(unittest.TestCase):
    def test_the_password_goes_through_stdin_and_an_older_profile_for_the_wifi_goes(self):
        calls = []

        def nmcli(*args, secret=None, wait=8):
            calls.append((args, secret))
            if args[:2] == ('-t', '-e'):
                return result(output='old-uuid:802-11-wireless\n')
            if args[:2] == ('-g', '802-11-wireless.ssid'):
                return result(output='Glink 1\n')
            return result()

        with patch.object(setup, 'nmcli', side_effect=nmcli):
            self.assertIsNone(setup.connect('Glink 1', '@11235813', 'WPA2', 'wlo1'))
        flat = [' '.join(args) for args, _ in calls]
        self.assertFalse(any('@11235813' in line for line in flat))
        up = next((args, secret) for args, secret in calls if args[:2] == ('connection', 'up'))
        self.assertEqual(up[1], '802-11-wireless-security.psk:@11235813\n')
        self.assertIn('connection delete uuid old-uuid', flat)

    def test_a_failed_join_leaves_no_profile_and_says_why(self):
        calls = []

        def nmcli(*args, secret=None, wait=8):
            calls.append(args)
            if args[:2] == ('connection', 'up'):
                return result(4, error='Error: Connection activation failed: Secrets were required, but not provided.')
            return result()

        with patch.object(setup, 'nmcli', side_effect=nmcli):
            self.assertEqual(setup.connect('Glink 1', 'wrongpass', 'WPA2', 'wlo1'), 'WRONG_PASSWORD')
        self.assertEqual(calls[-1][:2], ('connection', 'delete'))

    def test_a_refused_key_ends_the_join_early_as_a_wrong_password(self):
        # NetworkManager keeps retrying a wrong key until its wait runs out; wpa_supplicant says so.
        released = []

        def nmcli(*args, secret=None, wait=8):
            if args[:2] == ('connection', 'up'):
                for _ in range(100):
                    if released:
                        return result(4, error='Error: Connection activation failed')
                    time.sleep(.01)
                raise subprocess.TimeoutExpired('nmcli', wait)
            if args[:2] == ('connection', 'down'):
                released.append(True)
            return result()

        with patch.object(setup, 'nmcli', side_effect=nmcli), \
             patch.object(setup, 'wrong_keys', return_value=2):
            self.assertEqual(setup.connect('Glinks 1', 'wrongpass', 'WPA2', 'wlo1'), 'WRONG_PASSWORD')
        self.assertTrue(released)

    def test_a_join_that_hangs_is_a_timeout(self):
        def nmcli(*args, secret=None, wait=8):
            if args[:2] == ('connection', 'up'):
                raise subprocess.TimeoutExpired('nmcli', wait)
            return result()

        with patch.object(setup, 'nmcli', side_effect=nmcli):
            self.assertEqual(setup.connect('Far', 'password1', 'WPA2', 'wlo1'), 'TIMEOUT')

    def test_an_open_network_sends_no_secret(self):
        seen = []
        with patch.object(setup, 'nmcli', side_effect=lambda *a, secret=None, wait=8: seen.append((a, secret)) or result()):
            setup.connect('Cafe', '', '', 'wlo1')
        self.assertTrue(all(secret is None for _, secret in seen))
        self.assertFalse(any('wifi-sec.key-mgmt' in args for args, _ in seen))


class Join(unittest.TestCase):
    NETWORKS = [dict(ssid='Glink 1', signal=80, security='WPA2')]

    def test_wifi_internet_and_ticket_sign_the_computer_in(self):
        with patch.object(setup, 'connect', return_value=None) as connect, \
             patch.object(setup, 'internet', return_value=True), \
             patch.object(setup, 'sign_in', return_value=(True, '')) as sign_in, \
             patch.object(setup, 'signed_in', return_value=True):
            out = setup.join(dict(ssid='Glink 1', password='@11235813', ticket='t'), self.NETWORKS, 'wlo1')
        self.assertEqual(out, dict(state='done', ssid='Glink 1', signedIn=True))
        connect.assert_called_once_with('Glink 1', '@11235813', 'WPA2', 'wlo1')
        sign_in.assert_called_once_with('t')

    def test_wifi_without_internet_is_forgotten_and_reported(self):
        with patch.object(setup, 'connect', return_value=None), \
             patch.object(setup, 'internet', return_value=False), \
             patch.object(setup, 'forget') as forget:
            out = setup.join(dict(ssid='Hotel', password='password1'), self.NETWORKS, 'wlo1')
        forget.assert_called_once_with('Hotel')
        self.assertEqual(out['error'], 'NO_INTERNET')
        self.assertIn('"Hotel"', out['message'])

    def test_a_wrong_password_comes_back_with_its_message(self):
        with patch.object(setup, 'connect', return_value='WRONG_PASSWORD'):
            out = setup.join(dict(ssid='Glink 1', password='wrongpass'), self.NETWORKS, 'wlo1')
        self.assertEqual(out, dict(state='failed', error='WRONG_PASSWORD', ssid='Glink 1',
                                   message='The password for "Glink 1" is not right. Passwords are case-sensitive.'))

    def test_a_hidden_network_is_protected_when_a_password_is_given(self):
        with patch.object(setup, 'connect', return_value='NOT_FOUND') as connect:
            setup.join(dict(ssid='Hidden', password='password1'), self.NETWORKS, 'wlo1')
        connect.assert_called_once_with('Hidden', 'password1', 'WPA2', 'wlo1')

    def test_a_refused_ticket_still_keeps_the_wifi(self):
        with patch.object(setup, 'connect', return_value=None), \
             patch.object(setup, 'internet', return_value=True), \
             patch.object(setup, 'sign_in', return_value=(False, 'This ticket was already used or has expired.')):
            out = setup.join(dict(ssid='Glink 1', password='@11235813', ticket='t'), self.NETWORKS, 'wlo1')
        self.assertEqual(out['state'], 'done')
        self.assertEqual(out['error'], 'SIGN_IN')


class Change(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        state = Path(self.folder.name)
        self.patches = [patch.object(setup, 'STATE', state), patch.object(setup, 'RESULT', state / 'r.json'),
                        patch.object(setup, 'wifi_device', return_value='wlo1'),
                        patch.object(setup, 'active_wifi', return_value='u-home'),
                        patch.object(setup, 'visible_networks', return_value=[dict(ssid='Cafe', signal=70, security='WPA2')])]
        for one in self.patches:
            one.start()

    def tearDown(self):
        for one in self.patches:
            one.stop()
        self.folder.cleanup()

    def test_a_failed_wifi_goes_back_to_the_one_it_was_on(self):
        with patch.object(setup, 'join', return_value=dict(state='failed', error='WRONG_PASSWORD', ssid='Cafe',
                                                            message='m')), \
             patch.object(setup, 'nmcli', return_value=result()) as nmcli, \
             patch.object(setup, 'online', return_value=True):
            setup.change(dict(ssid='Cafe', password='wrongpass'))
        nmcli.assert_called_once_with('connection', 'up', 'uuid', 'u-home', 'ifname', 'wlo1', wait=setup.SAVED_JOIN)
        out = setup.read_result()
        self.assertEqual((out['state'], out['error'], out['restored'], out['run']), ('failed', 'WRONG_PASSWORD', True, 1))

    def test_a_working_wifi_stays(self):
        with patch.object(setup, 'join', return_value=dict(state='done', ssid='Cafe', signedIn=True)), \
             patch.object(setup, 'nmcli') as nmcli:
            setup.change(dict(ssid='Cafe', password='password1'))
        nmcli.assert_not_called()
        self.assertEqual(setup.read_result()['state'], 'done')

    def test_a_bad_request_changes_nothing(self):
        with patch.object(setup, 'join') as join:
            setup.change(dict(ssid='', password='x'))
            setup.change(None)
        join.assert_not_called()
        self.assertEqual(setup.read_result()['error'], 'BAD_REQUEST')


class FromPhone(unittest.TestCase):
    def test_the_mark_is_there_before_the_sign_in_and_stays_only_when_it_worked(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'set-up-from-phone'
            with patch.object(setup, 'FROM_PHONE', marker), patch.object(setup, 'signed_in', return_value=False):
                with patch.object(setup, 'run_sign_in', side_effect=lambda t: (marker.exists(), '')):
                    self.assertEqual(setup.sign_in('t'), (True, ''))
                self.assertTrue(marker.exists())
                marker.unlink()
                with patch.object(setup, 'run_sign_in', return_value=(False, 'used')):
                    self.assertEqual(setup.sign_in('t'), (False, 'used'))
                self.assertFalse(marker.exists())


class FactoryReset(unittest.TestCase):
    def home(self, folder):
        home = Path(folder)
        for path in ['.harness/computer-id', '.harness/cli/data/e2e/identity.json', '.harness/cli/data/registry.json',
                     '.harness/auth/session.json', '.harness/tui/state.json', '.local/state/harness-os/onboarded',
                     '.claude/settings.json', 'projects/AGENTS.md']:
            (home / path).parent.mkdir(parents=True, exist_ok=True)
            (home / path).write_text('x')
        return home

    def run_reset(self, home, keep_wifi):
        users, wifi = [], []
        state = home / 'state'
        state.mkdir()
        (state / 'r.json').write_text('{}')
        (state / 'from-phone').touch()
        with patch.object(setup, 'HOME', home), patch.object(setup, 'RESULT', state / 'r.json'), \
             patch.object(setup, 'FROM_PHONE', state / 'from-phone'), patch.object(setup, 'NOW', state / 'now'), \
             patch.object(setup, 'as_user', side_effect=lambda *c, timeout=30: users.append(c) or result(output='2\n1\n')), \
             patch.object(setup.subprocess, 'run', return_value=result()), \
             patch.object(setup, 'rows', return_value=[['u-home', '802-11-wireless'], ['u-lo', 'loopback']]), \
             patch.object(setup, 'nmcli', side_effect=lambda *a, **k: wifi.append(a) or result()):
            setup.factory_reset(keep_wifi=keep_wifi)
        return users, wifi, state

    def test_it_is_as_just_flashed_but_the_same_computer(self):
        with tempfile.TemporaryDirectory() as folder:
            home = self.home(folder)
            users, wifi, state = self.run_reset(home, keep_wifi=False)
            left = sorted(str(p.relative_to(home)) for p in home.rglob('*') if p.is_file())
            self.assertIn('.harness/computer-id', left)
            self.assertIn('.harness/cli/data/e2e/identity.json', left)
            for gone in ['.harness/cli/data/registry.json', '.harness/auth/session.json', '.harness/tui/state.json',
                         '.local/state/harness-os/onboarded', 'state/r.json', 'state/from-phone']:
                self.assertNotIn(gone, left)
            # The person's own: the engines' sign-ins and their projects.
            self.assertIn('.claude/settings.json', left)
            self.assertIn('projects/AGENTS.md', left)
            # The account's tabs closed while still signed in, highest first, then the sign-out.
            closes = [c for c in users if 'kill-window' in c]
            self.assertEqual([c[-1] for c in closes], [':2', ':1'])
            self.assertLess(users.index(closes[-1]), next(i for i, c in enumerate(users) if 'logout' in c))
            self.assertEqual(wifi, [('connection', 'delete', 'uuid', 'u-home')])
            self.assertTrue((state / 'now').exists())

    def test_keep_wifi_keeps_it(self):
        with tempfile.TemporaryDirectory() as folder:
            _, wifi, _ = self.run_reset(self.home(folder), keep_wifi=True)
            self.assertEqual(wifi, [])

    def test_the_command_runs_it_in_a_unit_of_its_own(self):
        with patch.object(setup.subprocess, 'run', return_value=result()) as run, \
             patch.object(setup.sys, 'argv', ['setup.py', 'reset', '--keep-wifi']), \
             patch('builtins.print'):
            setup.main()
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ['/usr/bin/systemd-run', '--unit=harness-factory-reset'])
        self.assertEqual(command[-3:], ['reset', '--here', '--keep-wifi'])


class Screen(unittest.TestCase):
    def test_a_wifi_chosen_on_the_screen_ends_setup_and_its_list_goes(self):
        class Server:
            def shutdown(self): pass
            def server_close(self): pass

        with tempfile.TemporaryDirectory() as folder:
            listed = Path(folder) / 'setup-networks.json'
            seen = []
            with patch.object(setup, 'SCREEN_NETWORKS', listed), \
                 patch.object(setup, 'visible_networks', return_value=[dict(ssid='Glinks 1', signal=80, security='WPA2')]), \
                 patch.object(setup, 'start_hotspot', return_value=True), \
                 patch.object(setup, 'serve', return_value=Server()), \
                 patch.object(setup, 'read_result', return_value={}), \
                 patch.object(setup, 'signed_in', return_value=False), \
                 patch.object(setup, 'stop_hotspot'), \
                 patch.object(setup, 'hotspot_up', side_effect=lambda: seen.append(json.loads(listed.read_text())) or False), \
                 patch.object(setup, 'online', return_value=True), \
                 patch.object(setup.queue.Queue, 'get', side_effect=setup.queue.Empty):
                self.assertTrue(setup.setup_mode('wlo1'))
            self.assertEqual(seen[0], [dict(ssid='Glinks 1', signal=80, security='WPA2', device='wlo1')])
            self.assertFalse(listed.exists())


class Machine(unittest.TestCase):
    def test_online_ignores_the_setup_hotspot(self):
        with patch.object(setup, 'nmcli', return_value=result(output='harness-setup:802-11-wireless\nlo:loopback\n')):
            self.assertFalse(setup.online())
        with patch.object(setup, 'nmcli', return_value=result(output='Glink 1:802-11-wireless\n')):
            self.assertTrue(setup.online())
        with patch.object(setup, 'nmcli', return_value=result(output='Wired:802-3-ethernet\n')):
            self.assertTrue(setup.online())

    def test_saved_wifi_is_brought_up_by_name_not_by_device(self):
        calls = []

        def nmcli(*args, secret=None, wait=8):
            calls.append(args)
            if args[-2:] == ('connection', 'show'):
                return result(output='u-hot:802-11-wireless:harness-setup\nu-home:802-11-wireless:Glinks 1\nu-lo:loopback:lo\n')
            return result()

        with patch.object(setup, 'nmcli', side_effect=nmcli), patch.object(setup, 'online', return_value=True):
            self.assertTrue(setup.saved_comes_back('wlo1'))
        self.assertIn(('device', 'set', 'wlo1', 'autoconnect', 'yes'), calls)
        self.assertIn(('connection', 'up', 'uuid', 'u-home', 'ifname', 'wlo1'), calls)
        self.assertFalse(any('u-hot' in args for args in calls))
        self.assertFalse(any(args[:2] == ('device', 'connect') for args in calls))

    def test_the_hotspot_is_named_after_the_wifi_cards_own_address(self):
        with patch.object(setup, 'permanent_mac', return_value='b0:60:88:e7:bd:19'):
            self.assertEqual(setup.hotspot_name('wlo1'), 'Harness-BD19')
        # No address to read: the computer id, as before.
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(setup, 'permanent_mac', return_value=''), \
             patch.object(setup, 'COMPUTER_ID', Path(folder) / 'computer-id'):
            (Path(folder) / 'computer-id').write_text('601cb0af-9a2d-44cf-8381-df989bf4a192\n')
            self.assertEqual(setup.hotspot_name('wlo1'), 'Harness-A192')

    def test_the_permanent_address_falls_back_to_the_current_one(self):
        with tempfile.TemporaryDirectory() as folder, \
             patch.object(setup.fcntl, 'ioctl', side_effect=OSError('no ethtool')), \
             patch.object(setup, 'Path', side_effect=lambda *a: Path(folder, *a[1:]) if a and a[0] == '/sys/class/net' else Path(*a)):
            (Path(folder) / 'wlo1').mkdir()
            (Path(folder) / 'wlo1/address').write_text('aa:bb:cc:dd:ee:ff\n')
            self.assertEqual(setup.permanent_mac('wlo1'), 'aa:bb:cc:dd:ee:ff')
            self.assertEqual(setup.permanent_mac('nowhere'), '')

    def test_when_the_hotspot_opens_by_itself(self):
        cases = [
            # signed in, headless, saved Wi-Fi, seconds since start → seconds offline first (None: never)
            (False, False, False, 0, 0),        # just installed, screen, no Wi-Fi: at once
            (False, True, False, 0, 0),         # just installed, no screen: at once
            (False, False, True, 3, setup.SAVED_GRACE),   # saved Wi-Fi as it starts: a moment for it
            (False, False, True, 600, 0),       # later, still offline: at once
            (True, False, True, 600, None),     # signed-in laptop: its Wi-Fi page, never the hotspot
            (True, True, True, 3, setup.OFFLINE_AT_START),
            (True, True, True, 600, setup.OFFLINE_LATER),
        ]
        for signed, headless, saved, since, expected in cases:
            with patch.object(setup, 'signed_in', return_value=signed), \
                 patch.object(setup, 'headless', return_value=headless), \
                 patch.object(setup, 'saved_wifi', return_value=saved):
                self.assertEqual(setup.offline_wait(1000 + since, 1000), expected,
                                 (signed, headless, saved, since))

    def test_the_hotspot_is_named_after_the_computer(self):
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            with patch.object(setup, 'COMPUTER_ID', state / 'computer-id'):
                (state / 'computer-id').write_text('601cb0af-9a2d-44cf-8381-df989bf4a192\n')
                self.assertEqual(setup.hotspot_name(), 'Harness-A192')

    def test_the_hotspot_is_open_on_2_4_ghz(self):
        calls = []
        with patch.object(setup, 'nmcli', side_effect=lambda *a, secret=None, wait=8: calls.append((a, secret)) or result()):
            self.assertTrue(setup.start_hotspot('wlo1', 'Harness-A192'))
        add = next(args for args, _ in calls if args[:2] == ('connection', 'add'))
        self.assertIn('ap', add)
        self.assertIn('bg', add)
        self.assertFalse(any('wifi-sec.key-mgmt' in args for args, _ in calls))

    def test_only_a_computer_without_a_screen_is_headless(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'card1-eDP-1').mkdir()
            (root / 'card1-eDP-1/status').write_text('connected\n')
            (root / 'card1-HDMI-A-1').mkdir()
            (root / 'card1-HDMI-A-1/status').write_text('disconnected\n')
            with patch.object(setup, 'DRM', root), patch.object(setup, 'HEADLESS', root / 'headless'):
                self.assertFalse(setup.headless())
                (root / 'headless').touch()
                self.assertTrue(setup.headless())
                (root / 'headless').unlink()
                (root / 'card1-eDP-1/status').write_text('disconnected\n')
                self.assertTrue(setup.headless())

    def test_results_carry_the_run_for_the_phone(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(setup, 'STATE', Path(folder)), patch.object(setup, 'RESULT', Path(folder) / 'r.json'):
                setup.write_result(state='failed', run=3, error='WRONG_PASSWORD')
                self.assertEqual(setup.read_result()['run'], 3)
                self.assertEqual(json.loads((Path(folder) / 'r.json').read_text())['error'], 'WRONG_PASSWORD')


if __name__ == '__main__':
    unittest.main()
