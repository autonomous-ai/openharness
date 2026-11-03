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


if __name__ == '__main__':
    unittest.main()
