"""The Desktop test flavor's environment, identity and guard (docs/plans/2026-11-03-desktop-test-flavor-design.md).

Run: python3 -m unittest desktop/tool/test_test_flavor.py
"""
import hashlib
import plistlib
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import test_flavor  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


class FlavorEnvTest(unittest.TestCase):
    def setUp(self):
        self.real_home = Path('/Users/person')
        self.test_home = Path('/private/tmp/harness-test-flavor.abc')
        self.shared = Path('/Users/person/.harness-test')
        self.base = {'HOME': str(self.real_home), 'PATH': '/usr/bin:/bin', 'PORT': '3000'}
        self.env = test_flavor.flavor_env(self.base, self.test_home, self.shared, 18990)

    def test_moves_every_per_user_resource_into_the_test_home(self):
        expected = {
            'HOME': str(self.test_home),
            'PORT': '18990',
            'TMUX_TMPDIR': str(self.test_home / 'tmux'),
            'CLAUDE_CONFIG_DIR': str(self.test_home / '.claude'),
            'CLAUDE_SECURESTORAGE_CONFIG_DIR': str(self.test_home / '.claude'),
            'CODEX_HOME': str(self.test_home / '.codex'),
            'HARNESS_AUTH_DIR': str(self.shared / 'auth'),
            'ADAPTER_COMPUTER_ID_FILE': str(self.shared / 'computer-id'),
            'ADAPTER_UPDATE_DISABLE': '1',
        }
        for key, value in expected.items():
            self.assertEqual(self.env.get(key), value, key)

    def test_overrides_a_port_already_in_the_shell_and_keeps_the_rest(self):
        self.assertEqual(self.env['PORT'], '18990')
        self.assertEqual(self.env['PATH'], '/usr/bin:/bin')
        self.assertEqual(self.base['PORT'], '3000', 'the base environment is not changed')

    def test_drops_what_an_agent_pane_inherits_from_the_person_s_daemon(self):
        # A Tester is usually a Harness agent: its pane carries the real daemon's folders and tmux server.
        inherited = {
            'ADAPTER_DATA_DIR': '/Users/person/.harness/cli/data',
            'ADAPTER_CLI_DIR': '/Users/person/.harness/cli',
            'HARNESS_HOOK_ROUTES_DIR': '/Users/person/.harness/hook-routes',
            'HARNESS_ENV_FILE': '/Users/person/.harness/env',
            'HARNESSD_PLATFORM': 'launchd',
            'TMUX': '/private/tmp/tmux-501/default,123,0',
            'TMUX_PANE': '%3',
        }
        env = test_flavor.flavor_env({**self.base, **inherited}, self.test_home, self.shared, 18990)
        for key in inherited:
            self.assertNotIn(key, env, key)

    def test_no_path_reaches_the_person_s_harness_folder(self):
        real_harness = self.real_home / '.harness'
        for key, value in self.env.items():
            if value.startswith('/'):
                path = Path(value)
                self.assertFalse(path == real_harness or real_harness in path.parents, f'{key}={value}')

    def test_the_claude_keychain_item_is_not_the_person_s(self):
        service = test_flavor.claude_keychain_service(self.env)
        self.assertNotEqual(service, 'Claude Code-credentials')
        digest = hashlib.sha256(str(self.test_home / '.claude').encode()).hexdigest()[:8]
        self.assertEqual(service, f'Claude Code-credentials-{digest}')

    def test_keychain_name_matches_the_cli_rule(self):
        # cli/src/lib/agentCredentials.ts claudeKeychainService: CLAUDE_SECURESTORAGE_CONFIG_DIR wins; neither set
        # means the plain name, which is the person's own item.
        self.assertEqual(test_flavor.claude_keychain_service({}), 'Claude Code-credentials')
        self.assertEqual(
            test_flavor.claude_keychain_service({'CLAUDE_SECURESTORAGE_CONFIG_DIR': '/a', 'CLAUDE_CONFIG_DIR': '/b'}),
            'Claude Code-credentials-' + hashlib.sha256(b'/a').hexdigest()[:8])
        # Empty CLAUDE_SECURESTORAGE_CONFIG_DIR means the plain name even with a config dir set
        # (desktop/lib/usage/usage_credentials.dart keychainService; the CLI's `secure ?? configDir`).
        self.assertEqual(
            test_flavor.claude_keychain_service({'CLAUDE_SECURESTORAGE_CONFIG_DIR': '', 'CLAUDE_CONFIG_DIR': '/b'}),
            'Claude Code-credentials')


class PatchInfoTest(unittest.TestCase):
    def setUp(self):
        # Read as macOS reads it: the source has '--' inside an XML comment, which Xcode and plutil accept
        # and Python's strict parser does not. The built app's Info.plist is clean either way.
        xml = subprocess.run(['plutil', '-convert', 'xml1', '-o', '-', str(REPO / 'desktop/macos/Runner/Info.plist')],
                             check=True, capture_output=True).stdout
        self.info = plistlib.loads(xml)
        self.patched = test_flavor.patch_info(self.info)

    def test_has_its_own_identity(self):
        self.assertEqual(self.patched['CFBundleIdentifier'], 'ai.autonomous.harness.test')
        self.assertEqual(self.patched['CFBundleName'], 'Harness Test')
        self.assertEqual(self.patched['CFBundleDisplayName'], 'Harness Test')
        self.assertEqual(self.patched['CFBundleExecutable'], 'Harness Test')

    def test_does_not_claim_harness_links(self):
        self.assertIn('CFBundleURLTypes', self.info, 'the installed app registers harness://')
        self.assertNotIn('CFBundleURLTypes', self.patched)

    def test_leaves_the_source_plist_unchanged(self):
        self.assertIn('CFBundleURLTypes', self.info)
        self.assertNotEqual(self.info.get('CFBundleIdentifier'), 'ai.autonomous.harness.test')


def _jwt(payload):
    import base64
    import json
    part = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    return f"{part({'alg': 'none'})}.{part(payload)}.signature"


class SameAccountGuardTest(unittest.TestCase):
    def setUp(self):
        import json
        import tempfile
        self.json = json
        self.root = Path(tempfile.mkdtemp(prefix='harness-test-flavor-guard.'))
        self.addCleanup(__import__('shutil').rmtree, self.root, ignore_errors=True)

    def session(self, name, **fields):
        path = self.root / name
        path.write_text(self.json.dumps({'version': 1, 'accessToken': _jwt({'sub': 'acct-from-token'}), **fields}))
        return path

    def test_reads_the_sign_in_account(self):
        path = self.session('a.json', signInAcct='acct-1', refreshToken='secret-refresh')
        self.assertEqual(test_flavor.session_account(path), 'acct-1')

    def test_an_older_session_falls_back_to_the_token_subject_and_never_returns_token_text(self):
        path = self.session('b.json', refreshToken='secret-refresh')
        account = test_flavor.session_account(path)
        self.assertEqual(account, 'acct-from-token')
        self.assertNotIn('secret', account)
        self.assertNotIn('.', account)

    def test_missing_or_unreadable_is_none(self):
        self.assertIsNone(test_flavor.session_account(self.root / 'missing.json'))
        broken = self.root / 'broken.json'
        broken.write_text('{not json')
        self.assertIsNone(test_flavor.session_account(broken))

    def test_the_same_account_is_refused_in_plain_words(self):
        with self.assertRaises(test_flavor.SameAccount) as refused:
            test_flavor.check_not_owner('acct-1', 'acct-1')
        self.assertEqual(str(refused.exception),
                         "The test copy signed in as this Mac's own account. Sign it in with the test account instead.")

    def test_another_account_passes(self):
        test_flavor.check_not_owner('acct-owner', 'acct-test')

    def test_an_unknown_test_account_is_refused(self):
        with self.assertRaises(test_flavor.SameAccount):
            test_flavor.check_not_owner('acct-owner', None)

    def test_a_person_who_is_not_signed_in_passes(self):
        test_flavor.check_not_owner(None, 'acct-test')


class FakeRunner:
    """Records commands; plays the build, copy and sign-in steps on disk where `start` reads their results."""

    def __init__(self, built_app, shared, account='acct-test'):
        self.built_app = built_app
        self.shared = shared
        self.account = account
        self.commands = []
        self.launched = []
        self.terminated = []
        self.alive_pids = set()
        self.taken_ports = set()

    def run(self, argv, env=None, interactive=False, check=True):
        argv = [str(a) for a in argv]
        self.commands.append((argv, env))
        if argv[0] == 'ditto':
            __import__('shutil').copytree(argv[1], argv[2])
        elif 'login' in argv:
            auth = self.shared / 'auth'
            auth.mkdir(parents=True, exist_ok=True)
            (auth / 'session.json').write_text(__import__('json').dumps(
                {'version': 1, 'accessToken': 'a.b.c', 'signInAcct': self.account}))
        return __import__('subprocess').CompletedProcess(argv, 0, '', '')

    def launch(self, argv, env):
        self.launched.append(([str(a) for a in argv], env))
        self.alive_pids.add(4242)
        return 4242

    def alive(self, pid):
        return pid in self.alive_pids

    def terminate(self, pid):
        self.terminated.append(pid)
        self.alive_pids.discard(pid)

    def port_free(self, port):
        return port not in self.taken_ports


class CommandsTest(unittest.TestCase):
    def setUp(self):
        import json
        import tempfile
        self.json = json
        self.root = Path(tempfile.mkdtemp(prefix='harness-test-flavor-cmds.'))
        self.addCleanup(__import__('shutil').rmtree, self.root, ignore_errors=True)
        self.repo = self.root / 'repo'
        built = self.repo / 'desktop/build/macos/Build/Products/Debug/Harness.app/Contents'
        (built / 'MacOS').mkdir(parents=True)
        (built / 'MacOS/Harness').write_text('binary')
        with (built / 'Info.plist').open('wb') as out:
            plistlib.dump({'CFBundleIdentifier': 'ai.autonomous.harness', 'CFBundleExecutable': 'Harness',
                           'CFBundleName': 'Harness', 'CFBundleURLTypes': [{'CFBundleURLSchemes': ['harness']}]}, out)
        self.person_home = self.root / 'person'
        (self.person_home / '.harness/auth').mkdir(parents=True)
        (self.person_home / '.harness/auth/session.json').write_text(
            json.dumps({'version': 1, 'accessToken': 'a.b.c', 'signInAcct': 'acct-owner'}))
        self.shared = self.person_home / '.harness-test'
        self.paths = test_flavor.Paths(repo=self.repo, shared=self.shared, person_home=self.person_home)
        self.runner = FakeRunner(built.parent, self.shared)
        self.homes = []

        def installer(cli_dir, test_home, node):
            self.homes.append(test_home)
            (test_home / '.harness/cli').mkdir(parents=True)
            (test_home / '.harness/cli/cli.js').write_text('')
            return test_home / '.harness/cli/cli.js'
        self.installer = installer

    def main(self, *argv):
        return test_flavor.main(list(argv), runner=self.runner, paths=self.paths, installer=self.installer)

    def state(self):
        path = self.repo / 'desktop/build/test-flavor/state.json'
        return self.json.loads(path.read_text()) if path.exists() else None

    def test_start_builds_for_its_own_port_and_launches_the_copy_in_the_test_environment(self):
        self.assertEqual(self.main('start'), 0)
        state = self.state()
        port = state['port']
        self.assertNotEqual(port, 18473)
        builds = [argv for argv, _ in self.runner.commands if any('build-macos-debug.sh' in a for a in argv)]
        self.assertEqual(len(builds), 1)
        self.assertIn(f'--dart-define=HARNESS_DAEMON_PORT={port}', builds[0])
        [(argv, env)] = self.runner.launched
        app = self.repo / 'desktop/build/test-flavor/Harness Test.app'
        self.assertEqual(argv, [str(app / 'Contents/MacOS/Harness Test')])
        self.assertTrue((app / 'Contents/MacOS/Harness Test').exists())
        self.assertEqual(env, test_flavor.flavor_env(dict(__import__('os').environ), Path(state['testHome']),
                                                     self.shared, port))
        with (app / 'Contents/Info.plist').open('rb') as source:
            info = plistlib.load(source)
        self.assertEqual(info['CFBundleIdentifier'], 'ai.autonomous.harness.test')
        self.assertNotIn('CFBundleURLTypes', info)
        self.assertEqual(state['appPid'], 4242)

    def test_signs_in_once_before_the_build_and_reuses_it(self):
        self.assertEqual(self.main('start'), 0)
        names = [' '.join(argv) for argv, _ in self.runner.commands]
        login = next(i for i, c in enumerate(names) if ' login --code' in c)
        build = next(i for i, c in enumerate(names) if 'build-macos-debug.sh' in c)
        self.assertLess(login, build)
        self.assertEqual(self.main('stop'), 0)
        self.runner.commands.clear()
        self.assertEqual(self.main('start'), 0)
        self.assertFalse(any(' login ' in ' '.join(argv) for argv, _ in self.runner.commands))

    def test_a_second_start_refuses_while_one_runs(self):
        self.assertEqual(self.main('start'), 0)
        with self.assertRaises(test_flavor.Refused) as refused:
            self.main('start')
        self.assertEqual(str(refused.exception), 'A test copy is already running; run stop first.')
        self.assertEqual(len(self.runner.launched), 1)

    def test_the_owner_s_account_is_refused_and_nothing_launches(self):
        self.runner.account = 'acct-owner'
        with self.assertRaises(test_flavor.SameAccount):
            self.main('start')
        self.assertEqual(self.runner.launched, [])
        self.assertFalse((self.shared / 'auth').exists(), 'the refused sign-in is removed')
        self.assertIsNone(self.state())
        self.assertFalse(self.homes[0].exists(), 'the new test home is removed')

    def test_a_port_taken_before_launch_fails_plainly_and_cleans_up(self):
        real_free = self.runner.port_free
        self.runner.port_free = lambda port: False if self.runner.commands else real_free(port)
        with self.assertRaises(test_flavor.Refused) as refused:
            self.main('start')
        self.assertRegex(str(refused.exception), r'^Port \d+ was taken; run start again\.$')
        self.assertEqual(self.runner.launched, [])
        self.assertIsNone(self.state())
        self.assertFalse(self.homes[0].exists())

    def test_stop_ends_only_the_recorded_app_and_removes_everything(self):
        self.assertEqual(self.main('start'), 0)
        home = Path(self.state()['testHome'])
        self.assertEqual(self.main('stop'), 0)
        self.assertEqual(self.runner.terminated, [4242])
        self.assertFalse(home.exists())
        self.assertFalse((self.repo / 'desktop/build/test-flavor/Harness Test.app').exists())
        self.assertIsNone(self.state())
        stops = [argv for argv, env in self.runner.commands if argv[-1] == 'stop']
        self.assertEqual(len(stops), 1, 'the test daemon is stopped through its own CLI')

    def test_stop_after_a_crash_still_cleans_up(self):
        self.assertEqual(self.main('start'), 0)
        home = Path(self.state()['testHome'])
        self.runner.alive_pids.clear()
        self.assertEqual(self.main('stop'), 0)
        self.assertEqual(self.runner.terminated, [])
        self.assertFalse(home.exists())
        self.assertIsNone(self.state())

    def test_status_warns_when_the_test_copy_is_now_the_owner_s_account(self):
        self.assertEqual(self.main('start'), 0)
        (self.shared / 'auth/session.json').write_text(
            self.json.dumps({'version': 1, 'accessToken': 'a.b.c', 'signInAcct': 'acct-owner'}))
        out = __import__('io').StringIO()
        with __import__('contextlib').redirect_stdout(out):
            self.assertEqual(self.main('status'), 1)
        self.assertIn(test_flavor.SAME_ACCOUNT, out.getvalue())


if __name__ == '__main__':
    unittest.main()
