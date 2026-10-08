"""Security boundary and package identity for the OS browser start page."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


host = module('browser_home_host', 'os/browser_home.py')
payload = module('home_payload', 'os/tools/browser_home_payload.py')
profile = module('home_profile', 'os/browser_profile.py')


def message(data):
    raw = json.dumps(data).encode()
    return io.BytesIO(struct.pack('=I', len(raw)) + raw)


class BrowserHome(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name)
        self.manifest = self.folder / 'native.json'
        self.origin = 'chrome-extension://' + 'a' * 32 + '/'
        self.manifest.write_text(json.dumps({'allowed_origins': [self.origin]}))
        self.launch = Mock(return_value='http://127.0.0.1:12345/#' + 'K' * 43)

    def invoke(self, request, origin=None):
        output = io.BytesIO()
        result = host.main([origin or self.origin], request, output,
                           manifest=self.manifest, launch=self.launch)
        raw = output.getvalue()
        if raw:
            self.assertEqual(struct.unpack('=I', raw[:4])[0], len(raw[4:]))
            return result, json.loads(raw[4:])
        return result, None

    def test_only_explicit_connections_action_can_start_helper(self):
        status, result = self.invoke(message({'action': 'connections'}))
        self.assertEqual(status, 0)
        self.assertEqual(result, {'url': self.launch.return_value})
        self.launch.assert_called_once_with()

    def test_other_origins_cannot_invoke_helper(self):
        for origin in ['https://example.com/', 'chrome-extension://' + 'b' * 32 + '/', self.origin + '?x']:
            self.assertEqual(self.invoke(message({'action': 'connections'}), origin), (1, None))
        self.launch.assert_not_called()

    def test_arbitrary_actions_parameters_and_malformed_messages_do_not_launch(self):
        for request in [message({'action': 'connections', 'url': 'https://evil.invalid'}),
                        message({'action': 'shell', 'command': 'id'}), message([]), message(None),
                        message({'action': 'connections', 'token': 'secret'}),
                        io.BytesIO(b''), io.BytesIO(b'\xff' * 4),
                        io.BytesIO(struct.pack('=I', 10) + b'{}'),
                        io.BytesIO(struct.pack('=I', 2) + b'\xff\xff')]:
            status, response = self.invoke(request)
            self.assertEqual(status, 1)
            self.assertEqual(response, {'error': 'Could not open Connections.'})
        self.launch.assert_not_called()

    def test_failure_does_not_relay_sensitive_exception(self):
        self.launch.side_effect = OSError('sensitive account or key')
        self.assertEqual(self.invoke(message({'action': 'connections'})),
                         (1, {'error': 'Could not open Connections.'}))

    def test_signed_extension_matches_reviewed_source_and_narrow_manifest(self):
        extension_id, version = payload.verify(ROOT / 'os/browser-home')
        manifest = json.loads((ROOT / 'os/browser-home/extension/manifest.json').read_text())
        self.assertEqual(manifest['permissions'], ['nativeMessaging'])
        self.assertEqual(manifest['chrome_url_overrides'], {'newtab': 'index.html'})
        self.assertFalse(set(manifest) & {'host_permissions', 'background', 'content_scripts',
                                         'externally_connectable', 'web_accessible_resources', 'update_url'})
        result = payload.stage(ROOT, self.folder / 'stage')
        self.assertEqual(result, {'extension_id': extension_id, 'version': version})
        native = json.loads((self.folder / 'stage/etc/chromium/native-messaging-hosts' /
                            (payload.HOST + '.json')).read_text())
        self.assertEqual(native['allowed_origins'], ['chrome-extension://' + extension_id + '/'])
        external = json.loads((self.folder / 'stage/usr/share/harness-os/browser-home/extension.json').read_text())
        self.assertEqual(external['descriptor']['external_version'], version)
        self.assertFalse((self.folder / 'stage/etc/chromium/policies').exists())

    def test_source_changes_or_crx_signature_changes_require_repacking(self):
        folder = self.folder / 'home'
        shutil.copytree(ROOT / 'os/browser-home', folder)
        source = folder / 'extension/home.js'
        original = source.read_bytes()
        source.write_bytes(original + b'\n// unreviewed\n')
        with self.assertRaisesRegex(ValueError, 'Repack'):
            payload.verify(folder)
        source.write_bytes(original)
        crx = folder / 'home.crx'
        raw = bytearray(crx.read_bytes())
        raw[-1] ^= 1
        crx.write_bytes(raw)
        with self.assertRaises(subprocess.CalledProcessError):
            payload.verify(folder)

    def test_first_launch_preserves_custom_newtab_in_any_existing_profile(self):
        package = self.folder / 'extension.json'
        identity = 'b' * 32
        package.write_text(json.dumps({'extension_id': identity, 'descriptor': {'external_crx': '/packaged.crx', 'external_version': '1.0'}}))
        root = self.folder / 'chromium'
        prefs = root / 'Profile 2/Preferences'
        prefs.parent.mkdir(parents=True)
        variants = [
            {'extensions': {'chrome_url_overrides': {'newtab': [{'entry': 'chrome-extension://' + 'c' * 32 + '/home.html', 'active': True}]}}},
            {'extensions': {'settings': {'c' * 32: {'manifest': {'chrome_url_overrides': {'newtab': 'index.html'}}}}}},
        ]
        for data in variants:
            raw = json.dumps(data)
            prefs.write_text(raw)
            self.assertFalse(profile.prepare(root, package))
            self.assertFalse((root / 'External Extensions').exists())
            self.assertEqual(prefs.read_text(), raw)
        prefs.write_text('{invalid')
        self.assertFalse(profile.prepare(root, package))
        self.assertEqual(prefs.read_text(), '{invalid')

    def test_prepare_writes_only_owned_descriptor_and_updates_without_profile_edits(self):
        package = self.folder / 'extension.json'
        identity = 'b' * 32
        descriptor = {'external_crx': '/packaged.crx', 'external_version': '1.0'}
        package.write_text(json.dumps({'extension_id': identity, 'descriptor': descriptor}))
        root = self.folder / 'chromium'
        prefs = root / 'Default/Preferences'
        prefs.parent.mkdir(parents=True)
        original = '{"session":{"restore_on_startup":1},"bookmark_bar":{"show_on_all_tabs":true}}'
        prefs.write_text(original)
        self.assertTrue(profile.prepare(root, package))
        target = root / 'External Extensions' / (identity + '.json')
        self.assertEqual(json.loads(target.read_text()), descriptor)
        self.assertEqual(prefs.read_text(), original)
        self.assertTrue(profile.prepare(root, package))
        descriptor['external_version'] = '1.1'
        package.write_text(json.dumps({'extension_id': identity, 'descriptor': descriptor}))
        self.assertTrue(profile.prepare(root, package))
        self.assertEqual(json.loads(target.read_text()), descriptor)
        self.assertEqual(prefs.read_text(), original)
        target.write_text('{"external_crx":"/user-choice.crx"}')
        self.assertFalse(profile.prepare(root, package))
        self.assertEqual(target.read_text(), '{"external_crx":"/user-choice.crx"}')

    def test_imported_or_later_customization_prevents_new_install_after_registration(self):
        package = self.folder / 'extension.json'
        identity = 'b' * 32
        descriptor = {'external_crx': '/packaged.crx', 'external_version': '1.0'}
        package.write_text(json.dumps({'extension_id': identity, 'descriptor': descriptor}))
        root = self.folder / 'chromium'
        self.assertTrue(profile.prepare(root, package))
        target = root / 'External Extensions' / (identity + '.json')
        prefs = root / 'Imported/Preferences'
        prefs.parent.mkdir(parents=True)
        original = json.dumps({'extensions': {'settings': {
            'c' * 32: {'manifest': {'chrome_url_overrides': {'newtab': 'home.html'}}}}}})
        prefs.write_text(original)
        self.assertTrue(profile.prepare(root, package))
        self.assertEqual(json.loads(target.read_text()), dict(descriptor, keep_if_present=True))
        self.assertEqual(prefs.read_text(), original)
        # Once a customization is observed, don't silently install into that
        # profile on a later launch or OS package update.
        prefs.write_text('{}')
        descriptor['external_version'] = '1.1'
        package.write_text(json.dumps({'extension_id': identity, 'descriptor': descriptor}))
        self.assertTrue(profile.prepare(root, package))
        self.assertEqual(json.loads(target.read_text()), dict(descriptor, keep_if_present=True))

    def test_unreadable_profile_restricts_an_existing_registration(self):
        package = self.folder / 'extension.json'
        identity = 'b' * 32
        descriptor = {'external_crx': '/packaged.crx', 'external_version': '1.0'}
        package.write_text(json.dumps({'extension_id': identity, 'descriptor': descriptor}))
        root = self.folder / 'chromium'
        self.assertTrue(profile.prepare(root, package))
        prefs = root / 'Default/Preferences'
        prefs.parent.mkdir(parents=True)
        prefs.write_text('{broken')
        self.assertTrue(profile.prepare(root, package))
        target = root / 'External Extensions' / (identity + '.json')
        self.assertTrue(json.loads(target.read_text())['keep_if_present'])
        self.assertEqual(prefs.read_text(), '{broken')


if __name__ == '__main__':
    unittest.main()
