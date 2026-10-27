import contextlib
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


class SetUpAsUnlocked(unittest.TestCase):
    """What a phone sent with the computer's password while its disk was locked (unlock/http)."""

    def run_it(self, request, signed_in=False, account='u-1'):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            sent = folder / 'phone-setup.json'
            if request is not None:
                sent.write_text(json.dumps(request))
            session = folder / 'session.json'
            session.write_text(json.dumps(dict(signInAcct=account)))
            users = []
            with patch.object(setup, 'PHONE_SETUP', sent), patch.object(setup, 'SESSION', session), \
                 patch.object(setup, 'STATE', folder), patch.object(setup, 'RESULT', folder / 'r.json'), \
                 patch.object(setup, 'wifi_device', return_value='wlo1'), \
                 patch.object(setup, 'online', return_value=False), \
                 patch.object(setup, 'signed_in', return_value=signed_in), \
                 patch.object(setup, 'as_user', side_effect=lambda *c, timeout=30: users.append(c)), \
                 patch.object(setup, 'join', return_value=dict(state='done', ssid='Glinks', signedIn=True)) as join:
                setup.set_up_as_unlocked()
                self.assertFalse(sent.exists(), 'read once, then gone')
                return join, users, setup.read_result()

    def test_its_wifi_and_ticket_are_joined_as_the_system_starts(self):
        request = dict(ssid='Glinks', password='wifi pass 1', security='WPA2', ticket='t', account='u-1')
        join, users, out = self.run_it(request)
        join.assert_called_once_with(request, [dict(ssid='Glinks', security='WPA2')], 'wlo1')
        self.assertEqual((out['state'], out['run']), ('done', 1))
        self.assertEqual(users, [])

    def test_the_same_account_stays_signed_in(self):
        _, users, _ = self.run_it(dict(ssid='Glinks', password='wifi pass 1', ticket='t', account='u-1'),
                                  signed_in=True, account='u-1')
        self.assertEqual(users, [])

    def test_another_account_is_signed_out_for_the_phones(self):
        join, users, _ = self.run_it(dict(ssid='Glinks', password='wifi pass 1', ticket='t', account='u-2'),
                                     signed_in=True, account='u-1')
        self.assertEqual(users, [('/usr/bin/harness', 'logout')])
        join.assert_called_once()

    def test_a_bad_request_is_said_and_joins_nothing(self):
        join, _, out = self.run_it(dict(ssid='', password='x'))
        join.assert_not_called()
        self.assertEqual(out['error'], 'BAD_REQUEST')

    def test_nothing_sent_is_nothing_done(self):
        join, _, out = self.run_it(None)
        join.assert_not_called()
        self.assertEqual(out, {})


class FromPhone(unittest.TestCase):
    def test_the_mark_is_there_before_the_sign_in_and_stays_only_when_it_worked(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / 'set-up-from-phone'
            with patch.object(setup, 'FROM_PHONE', marker), patch.object(setup, 'signed_in', return_value=False), \
                 patch.object(setup, 'as_user') as as_user:
                with patch.object(setup, 'run_sign_in', side_effect=lambda t: (marker.exists(), '')):
                    self.assertEqual(setup.sign_in('t'), (True, ''))
                self.assertTrue(marker.exists())
                # Online in the account only with its daemon, which no screen session may start.
                as_user.assert_called_once_with('systemctl', '--user', 'start', 'harness-daemon', timeout=150)
                marker.unlink()
                with patch.object(setup, 'run_sign_in', return_value=(False, 'used')):
                    self.assertEqual(setup.sign_in('t'), (False, 'used'))
                self.assertFalse(marker.exists())
                as_user.assert_called_once()


class Account:
    pw_uid, pw_gid = 1000, 1000


class FactoryReset(unittest.TestCase):
    def home(self, folder):
        home = Path(folder) / 'me'
        for path in ['.harness/computer-id', '.harness/cli/data/e2e/identity.json', '.harness/auth/session.json',
                     '.harness/tui/state.json', '.local/state/harness-os/updates/builds/x/cli.mjs',
                     '.claude/settings.json', 'projects/site/index.html', '.bashrc']:
            (home / path).parent.mkdir(parents=True, exist_ok=True)
            (home / path).write_text('x')
        return home

    def run_reset(self, home, **flags):
        self.steps, wifi, commands = [], [], []
        state = home.parent / 'state'
        state.mkdir()
        (state / 'r.json').write_text('{}')
        (state / 'from-phone').touch()
        def step(name):
            return lambda *a, **k: self.steps.append(name)
        def user(*command, timeout=30):
            self.steps.append(' '.join(command[-2:]))
            return result()
        def run(command, **_):
            commands.append(command)
            self.steps.append(' '.join(command[:3]))
            return result()
        with patch.object(setup, 'HOME', home), patch.object(setup, 'RESULT', state / 'r.json'), \
             patch.object(setup, 'FROM_PHONE', state / 'from-phone'), patch.object(setup, 'NOW', state / 'now'), patch.object(setup, 'PHONE_SETS_UP', state / 'phone'), \
             patch.object(setup, 'SCREEN', state / 'screen'), patch.object(setup, 'as_user', side_effect=user), \
             patch.object(setup.subprocess, 'run', side_effect=run), patch.object(setup.time, 'sleep'), \
             patch.object(setup.pwd, 'getpwnam', return_value=Account()), \
             patch.object(setup, 'rows', return_value=[['u-home', '802-11-wireless'], ['u-lo', 'loopback']]), \
             patch.object(setup, 'nmcli', side_effect=lambda *a, **k: wifi.append(a) or result()), \
             patch.object(setup, 'forget_desk', side_effect=step('forget-desk')), \
             patch.object(setup, 'remove_from_account', side_effect=step('remove-from-account')), \
             patch.object(setup, 'restore_initial_password', side_effect=step('restore-password')):
            setup.factory_reset(**flags)
        return wifi, commands, state

    def test_it_is_as_just_installed(self):
        with tempfile.TemporaryDirectory() as folder:
            home = self.home(folder)
            wifi, commands, state = self.run_reset(home)
            # Everything of the person: projects, sign-ins, the downloaded hn/CLI, the computer's id
            # and device key (a new computer to its next account). The skeleton is copied back.
            self.assertEqual(sorted(str(p.relative_to(home)) for p in home.rglob('*')), ['projects'])
            self.assertIn(['cp', '-a', '/etc/skel/.', str(home)], commands)
            self.assertIn(['chown', '-R', '1000:1000', str(home)], commands)
            self.assertFalse((state / 'r.json').exists() or (state / 'from-phone').exists())
            self.assertIn(['systemctl', 'disable', '--now', 'sshd.service'], commands)
            self.assertEqual(wifi, [('connection', 'delete', 'uuid', 'u-home')])
            self.assertTrue((state / 'now').exists() and (state / 'phone').exists())

    def test_off_its_account_while_signed_in_then_every_process_before_the_files(self):
        with tempfile.TemporaryDirectory() as folder:
            self.run_reset(self.home(folder))
            order = [self.steps.index(s) for s in ['forget-desk', 'remove-from-account', '/usr/bin/harness logout',
                                                    'loginctl terminate-user me', 'cp -a /etc/skel/.',
                                                    'restore-password', 'systemctl start user@1000.service',
                                                    'systemctl restart getty@tty1.service']]
            self.assertEqual(order, sorted(order))

    def test_a_test_machine_keeps_its_wifi_and_ssh(self):
        with tempfile.TemporaryDirectory() as folder:
            wifi, commands, _ = self.run_reset(self.home(folder), keep_wifi=True, keep_ssh=True)
            self.assertEqual(wifi, [])
            self.assertNotIn(['systemctl', 'disable', '--now', 'sshd.service'], commands)

    def test_the_desk_forgets_this_computer_alone(self):
        tabs = [{'id': 'own', 'panes': [{'machineId': 'me', 'agentId': 'a'}]},
                {'id': 'shared', 'panes': [{'machineId': 'me', 'agentId': 'b'}, {'machineId': 'mac', 'agentId': 'c'}]},
                {'id': 'theirs', 'panes': [{'machineId': 'mac', 'agentId': 'd'}]}]
        written = []
        with patch.object(setup, 'as_user', return_value=result(output='{"machineId": "me"}')), \
             patch.object(setup, 'desk_ops', side_effect=lambda ops=None: written.append(ops) or tabs):
            setup.forget_desk()
        self.assertEqual(written[-1], [{'op': 'tab.close', 'id': 'own'},
                                       {'op': 'pane.remove', 'tabId': 'shared', 'machineId': 'me', 'agentId': 'b'}])

    def test_the_commands_run_in_units_of_their_own(self):
        for argv, unit, tail in [(['reset', '--keep-wifi'], 'harness-factory-reset', ['reset', '--here', '--keep-wifi']),
                                 (['sign-out'], 'harness-sign-out', ['sign-out', '--here'])]:
            with self.subTest(argv=argv), patch.object(setup.subprocess, 'run', return_value=result()) as run, \
                 patch.object(setup.sys, 'argv', ['setup.py', *argv]), patch('builtins.print'):
                setup.main()
            command = run.call_args.args[0]
            self.assertEqual(command[:2], ['/usr/bin/systemd-run', '--unit=' + unit])
            self.assertEqual(command[-len(tail):], tail)


class SignOut(unittest.TestCase):
    def test_it_signs_out_and_opens_the_hotspot_keeping_everything_of_the_person(self):
        users, wifi = [], []
        with tempfile.TemporaryDirectory() as folder:
            state = Path(folder)
            (state / 'from-phone').touch()
            with patch.object(setup, 'as_user', side_effect=lambda *c, timeout=30: users.append(c) or result()), \
                 patch.object(setup, 'FROM_PHONE', state / 'from-phone'), patch.object(setup, 'NOW', state / 'now'), patch.object(setup, 'PHONE_SETS_UP', state / 'phone'), \
                 patch.object(setup, 'rows', return_value=[['u-home', '802-11-wireless']]), \
                 patch.object(setup, 'nmcli', side_effect=lambda *a, **k: wifi.append(a) or result()):
                setup.sign_out()
            self.assertEqual(users, [('/usr/bin/harness', 'logout')])
            self.assertEqual(wifi, [('connection', 'delete', 'uuid', 'u-home')])
            self.assertTrue((state / 'now').exists() and (state / 'phone').exists())


class Password(unittest.TestCase):
    def change(self, request, device=Path('/dev/disk/by-uuid/u'), opens=True, record=None):
        saved, replaced, runs = [], [], []
        with patch.object(setup, 'luks_device', return_value=device), \
             patch.object(setup, 'opens_disk', return_value=opens), patch.object(setup, 'opens_account', return_value=opens), \
             patch.object(setup, 'replace_disk_key', side_effect=lambda *a: replaced.append(a)), \
             patch.object(setup, 'account_record', return_value=dict(record or {})), \
             patch.object(setup, 'save_account_record', side_effect=saved.append), \
             patch.object(setup.subprocess, 'run', side_effect=lambda c, **k: runs.append((c, k.get('input'))) or result()), \
             patch.object(setup, 'log'):
            answer = setup.change_password(request)
        return answer, replaced, saved, runs

    def test_the_disk_and_the_account_change_together(self):
        answer, replaced, saved, runs = self.change({'current': '1234', 'new': 'abcd'}, record={'initial': '1234'})
        self.assertEqual(answer, {'ok': True, 'disk': True})
        self.assertEqual(replaced, [(Path('/dev/disk/by-uuid/u'), '1234', 'abcd')])
        self.assertEqual(saved, [{'initial': '1234', 'current': 'abcd'}])
        self.assertEqual(runs, [(['chpasswd'], b'me:abcd\n')])

    def test_unencrypted_it_is_the_account_alone(self):
        answer, replaced, saved, runs = self.change({'current': '1234', 'new': 'abcd'}, device=None)
        self.assertEqual(answer, {'ok': True, 'disk': False})
        self.assertEqual((replaced, saved), ([], []))
        self.assertEqual(runs, [(['chpasswd'], b'me:abcd\n')])

    def test_a_wrong_or_unusable_one_changes_nothing(self):
        for request, error in [({'current': 'nope', 'new': 'abcd'}, 'WRONG_PASSWORD'),
                               ({'current': '1234', 'new': '1234'}, 'SAME'),
                               ({'current': '1234', 'new': ''}, 'BAD_REQUEST'),
                               ({'current': '1234', 'new': 'a\nb'}, 'BAD_REQUEST'), (None, 'BAD_REQUEST')]:
            with self.subTest(request=request):
                answer, replaced, saved, runs = self.change(request, opens=request is None or request.get('current') == '1234')
                self.assertEqual(answer['error'], error)
                self.assertEqual((replaced, saved, runs), ([], [], []))

    def test_a_reset_puts_back_the_installation_password(self):
        saved, replaced, runs = [], [], []
        record = {'shadow': '$y$j9T$old', 'initial': '1234', 'current': 'abcd'}
        with patch.object(setup, 'account_record', return_value=dict(record)), \
             patch.object(setup, 'luks_device', return_value=Path('/dev/x')), \
             patch.object(setup, 'opens_disk', side_effect=lambda d, s: s == 'abcd'), \
             patch.object(setup, 'replace_disk_key', side_effect=lambda *a: replaced.append(a)), \
             patch.object(setup, 'save_account_record', side_effect=saved.append), \
             patch.object(setup.subprocess, 'run', side_effect=lambda c, **k: runs.append(c) or result()), \
             patch.object(setup, 'log'):
            setup.restore_initial_password()
        self.assertEqual(runs, [['usermod', '-p', '$y$j9T$old', 'me']])
        self.assertEqual(replaced, [(Path('/dev/x'), 'abcd', '1234')])
        self.assertEqual(saved[-1]['current'], '1234')

    def test_a_computer_installed_before_keeps_its_password(self):
        with patch.object(setup, 'account_record', return_value={}), \
             patch.object(setup, 'luks_device', return_value=Path('/dev/x')), \
             patch.object(setup, 'replace_disk_key') as replace, \
             patch.object(setup.subprocess, 'run') as run, patch.object(setup, 'log'):
            setup.restore_initial_password()
        replace.assert_not_called()
        run.assert_not_called()


class Ssh(unittest.TestCase):
    def test_on_off_and_the_private_addresses(self):
        links = [{'ifname': 'wlo1', 'addr_info': [{'local': '172.168.21.13'}]},
                 {'ifname': 'harness-setup', 'addr_info': [{'local': '10.42.0.1'}]}]
        calls = []
        def run(command, **_):
            calls.append(command)
            if command[0] == 'ip':
                return result(output=json.dumps(links))
            return result(output='enabled' if command[1] == 'is-enabled' else 'active')
        with patch.object(setup.subprocess, 'run', side_effect=run):
            answer = setup.ssh('on')
        self.assertEqual(calls[0], ['systemctl', 'enable', '--now', 'sshd.service'])
        self.assertEqual(answer, {'enabled': True, 'active': True, 'user': 'me',
                                  'addresses': [{'interface': 'wlo1', 'address': '172.168.21.13'}]})


class Name(unittest.TestCase):
    def name(self, hostname):
        with tempfile.TemporaryDirectory() as folder:
            etc = Path(folder)
            (etc / 'hostname').write_text(hostname + '\n')
            (etc / 'hosts').write_text(f'127.0.0.1 localhost\n::1 localhost\n127.0.1.1 {hostname}\n')
            calls = []
            with patch.object(setup, 'HOSTNAME', etc / 'hostname'), patch.object(setup, 'HOSTS', etc / 'hosts'), \
                 patch.object(setup, 'hotspot_name', return_value='Harness-BD19'), \
                 patch.object(setup.subprocess, 'run', side_effect=lambda command, **_: calls.append(command) or result()):
                setup.name_computer('wlan0')
            return calls, (etc / 'hosts').read_text()

    def test_the_installers_name_becomes_the_hotspots(self):
        calls, hosts = self.name('harness')
        self.assertEqual(calls, [['hostnamectl', 'set-hostname', 'Harness-BD19']])
        self.assertIn('127.0.1.1 Harness-BD19\n', hosts)

    def test_a_name_somebody_chose_stays(self):
        calls, hosts = self.name('studio')
        self.assertEqual(calls, [])
        self.assertIn('127.0.1.1 studio\n', hosts)


class InstallGh(unittest.TestCase):
    def install(self, present, *answers):
        """install_gh with gh [present] or not, pacman exiting with each of [answers] in turn (0 puts gh there)."""
        calls = []
        replies = iter(answers)
        with tempfile.TemporaryDirectory() as folder:
            gh = Path(folder) / 'gh'
            if present:
                gh.touch()
            def run(command, **_):
                calls.append(command)
                code = next(replies)
                if code == 0:
                    gh.touch()
                return result(code, '', '' if code == 0 else 'error: failed retrieving file\n')
            with patch.object(setup, 'GH', gh), patch.object(setup.subprocess, 'run', side_effect=run), \
                 patch.object(setup, 'log'):
                return setup.install_gh(), calls

    def test_present_it_installs_nothing(self):
        self.assertEqual(self.install(True), ({'installed': True}, []))

    def test_gone_it_is_put_back_from_the_computers_repositories(self):
        answer, calls = self.install(False, 0)
        self.assertEqual(answer, {'installed': True})
        self.assertEqual(calls, [['pacman', '-S', '--needed', '--noconfirm', 'github-cli']])

    def test_with_its_databases_refreshed_from_the_same_snapshot_when_they_fall_short(self):
        answer, calls = self.install(False, 1, 0)
        self.assertEqual(answer, {'installed': True})
        self.assertEqual(calls[1], ['pacman', '-S', '-y', '--needed', '--noconfirm', 'github-cli'])

    def test_says_why_it_could_not(self):
        answer, _ = self.install(False, 1, 1)
        self.assertEqual(answer, {'installed': False,
                                  'message': 'The GitHub CLI could not be installed: error: failed retrieving file'})


class Server:
    def shutdown(self): pass
    def server_close(self): pass


class Screen(unittest.TestCase):
    def hotspot(self, **checks):
        """setup_mode with nobody on the hotspot, each check (screen_here, signed_in, online,
        hotspot_up) as given; returns its result and whether the hotspot went."""
        values = dict(screen_here=False, signed_in=False, online=False, hotspot_up=True) | checks
        with contextlib.ExitStack() as stack:
            for name, value in values.items():
                stack.enter_context(patch.object(setup, name, side_effect=value) if callable(value)
                                    else patch.object(setup, name, return_value=value))
            stack.enter_context(patch.object(setup, 'visible_networks', return_value=[]))
            start = stack.enter_context(patch.object(setup, 'start_hotspot', return_value=True))
            stack.enter_context(patch.object(setup, 'serve', return_value=Server()))
            stack.enter_context(patch.object(setup, 'read_result', return_value={}))
            stop = stack.enter_context(patch.object(setup, 'stop_hotspot'))
            stack.enter_context(patch.object(setup, 'phones_on', return_value=True))
            stack.enter_context(patch.object(setup, 'wait_online', return_value=False))
            stack.enter_context(patch.object(setup.queue.Queue, 'get', side_effect=setup.queue.Empty))
            return setup.setup_mode('wlo1'), start.call_count, stop.called

    def test_the_screens_wifi_page_takes_the_radio(self):
        # Someone typed the computer's password at its screen and opened its Wi-Fi page.
        screen = iter([False, True])
        self.assertEqual(self.hotspot(screen_here=lambda: next(screen)), (False, 1, True))

    def test_signed_in_at_the_screen_the_hotspot_goes(self):
        signed = iter([False, False, True])
        self.assertEqual(self.hotspot(signed_in=lambda: next(signed), online=True), (True, 1, True))

    def test_not_signed_in_a_cable_keeps_the_hotspot_for_the_phone(self):
        # On a cable, the hotspot stays: the phone signs the computer in over it.
        checks = iter([False, False, False, True])
        result, starts, _ = self.hotspot(online=True, screen_here=lambda: next(checks))
        self.assertEqual((result, starts), (True, 1))

    def test_signed_in_a_cable_ends_the_hotspot(self):
        self.assertEqual(self.hotspot(signed_in=True, online=True), (True, 1, True))


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
            # signed in, headless, online, screen's Wi-Fi page open, seconds since start
            #   → seconds as it is first (None: not now)
            (False, False, False, False, 0, 0),     # just installed, screen, no network: at once
            (False, True, False, False, 0, 0),      # just installed, no screen: at once
            (False, False, True, False, 0, 0),      # not signed in on Wi-Fi or a cable: at once
            (False, False, False, True, 0, None),   # someone at the screen chooses a Wi-Fi
            (True, False, False, False, 600, None), # signed-in laptop: its Wi-Fi page, never the hotspot
            (True, True, True, False, 600, None),   # signed in and online: nothing to do
            (True, True, False, False, 3, setup.OFFLINE_AT_START),
            (True, True, False, False, 600, setup.OFFLINE_LATER),
        ]
        for signed, headless, online, screen, since, expected in cases:
            with patch.object(setup, 'signed_in', return_value=signed), \
                 patch.object(setup, 'headless', return_value=headless), \
                 patch.object(setup, 'online', return_value=online), \
                 patch.object(setup, 'screen_here', return_value=screen):
                self.assertEqual(setup.hotspot_wait(1000 + since, 1000), expected,
                                 (signed, headless, online, screen, since))

    def test_the_screen_holds_the_radio_until_signed_in(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'setup-screen'
            with patch.object(setup, 'SCREEN', path), patch.object(setup, 'signed_in', return_value=False):
                self.assertFalse(setup.screen_here())
                path.touch()
                self.assertTrue(setup.screen_here())
            with patch.object(setup, 'SCREEN', path), patch.object(setup, 'signed_in', return_value=True):
                self.assertFalse(setup.screen_here())
                self.assertFalse(path.exists())

    def test_on_a_cable_a_ticket_alone_signs_in(self):
        self.assertIsNone(setup.check_request(dict(ticket='t'), wired=True))
        self.assertEqual(setup.check_request(dict(ticket='t')), 'Choose a Wi-Fi network.')
        self.assertIsNotNone(setup.check_request(dict(), wired=True))
        with patch.object(setup, 'internet', return_value=True), \
             patch.object(setup, 'connect') as connect, \
             patch.object(setup, 'sign_in', return_value=(True, '')), \
             patch.object(setup, 'signed_in', return_value=True):
            self.assertEqual(setup.join(dict(ticket='t'), [], 'wlo1'), dict(state='done', ssid='', signedIn=True))
        connect.assert_not_called()
        with patch.object(setup, 'internet', return_value=False):
            self.assertEqual(setup.join(dict(ticket='t'), [], 'wlo1')['error'], 'NO_INTERNET_WIRED')

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
