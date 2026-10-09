"""Security boundary and package identity for the OS browser start page."""
import importlib.util
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

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
        self.ready = Mock()

    def invoke(self, request, origin=None):
        output = io.BytesIO()
        result = host.main([origin or self.origin], request, output,
                           manifest=self.manifest, launch=self.launch, ready=self.ready)
        raw = output.getvalue()
        if raw:
            self.assertEqual(struct.unpack('=I', raw[:4])[0], len(raw[4:]))
            return result, json.loads(raw[4:])
        return result, None

    def test_only_explicit_connections_action_can_start_helper(self):
        status, result = self.invoke(message({'action': 'connections'}))
        self.assertEqual(status, 0)
        self.assertEqual(result, {'ok': True})
        self.launch.assert_called_once_with()

    def test_native_open_uses_os_launcher_without_exposing_capability(self):
        with patch.object(host.subprocess, 'run') as run:
            host.open_connections()
        run.assert_called_once_with(['/usr/bin/harness', 'connections'],
                                    check=True, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=30)

    def test_other_origins_cannot_invoke_helper(self):
        for origin in ['https://example.com/', 'chrome-extension://' + 'b' * 32 + '/', self.origin + '?x']:
            self.assertEqual(self.invoke(message({'action': 'connections'}), origin), (1, None))
        self.launch.assert_not_called()
        self.ready.assert_not_called()

    def test_install_handshake_never_starts_connections(self):
        self.assertEqual(self.invoke(message({'action': 'installed'})), (0, {'ok': True}))
        self.ready.assert_called_once_with()
        self.launch.assert_not_called()
        self.assertEqual(self.invoke(message({'action': 'installed', 'path': '/unexpected'}))[0], 1)
        self.ready.assert_called_once_with()

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
        self.assertEqual(manifest['background'], {'service_worker': 'installed.js'})
        self.assertFalse(set(manifest) & {'host_permissions', 'content_scripts',
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

    def test_existing_browser_profiles_never_start_priming_process(self):
        for relative in ['Local State', 'Default/Preferences', 'Profile 2/Secure Preferences']:
            root = self.folder / relative.replace('/', '-')
            state = root / relative
            state.parent.mkdir(parents=True)
            state.write_text('{}')
            endpoint = root / 'runtime/ready'
            with patch.object(profile, 'startup_socket', return_value=endpoint), patch.object(profile.subprocess, 'Popen') as child:
                self.assertFalse(profile.prime(root))
                child.assert_not_called()
                self.assertEqual(state.read_text(), '{}')

    def test_priming_timeout_closes_only_its_own_child_and_removes_socket(self):
        root = self.folder / 'pristine'
        root.mkdir()
        # Unix socket paths are limited to about 100 bytes, including macOS's
        # long default temporary-directory prefix.
        runtime = tempfile.TemporaryDirectory(prefix='hn-home-', dir='/tmp')
        self.addCleanup(runtime.cleanup)
        endpoint = Path(runtime.name) / 'ready'
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO())
        child.poll.return_value = None
        with patch.object(profile, 'startup_socket', return_value=endpoint), patch.object(profile.subprocess, 'Popen', return_value=child) as start:
            self.assertFalse(profile.prime(root, deadline_seconds=.01))
            start.assert_called_once()
            self.assertTrue(start.call_args.kwargs['start_new_session'])
            child.wait.assert_called_once_with(timeout=3)
        self.assertFalse(endpoint.exists())
        self.assertTrue(child.stdin.closed)

    def test_priming_waits_for_real_install_acknowledgment_then_closes_child(self):
        root = self.folder / 'pristine'
        root.mkdir()
        runtime = tempfile.TemporaryDirectory(prefix='hn-home-', dir='/tmp')
        self.addCleanup(runtime.cleanup)
        endpoint = Path(runtime.name) / 'ready'
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO())
        child.poll.return_value = None
        def start(*args, **kwargs):
            self.assertEqual(args[0][-1], str(root))
            profile.installed()
            return child
        with patch.object(profile, 'startup_socket', return_value=endpoint), patch.object(profile.subprocess, 'Popen', side_effect=start):
            self.assertTrue(profile.prime(root))
        child.wait.assert_called_once_with(timeout=3)
        self.assertFalse(endpoint.exists())

    def test_url_arriving_during_preparation_waits_and_is_not_lost(self):
        runtime = tempfile.TemporaryDirectory(prefix='hn-home-', dir='/tmp')
        self.addCleanup(runtime.cleanup)
        endpoint = Path(runtime.name) / 'ready'
        preparing, finish, requested = threading.Event(), threading.Event(), threading.Event()
        calls, outcomes = [], []
        def prime(root):
            preparing.set()
            return finish.wait(2)
        def execute(args):
            self.assertTrue(finish.is_set())
            calls.append(args)
            return 0
        def second():
            requested.set()
            outcomes.append(profile.launch(['https://example.test/'], execute=execute))
        with patch.object(profile, 'startup_socket', return_value=endpoint), patch.object(profile, 'prepare', return_value=True), patch.object(profile, 'prime', side_effect=prime), patch.dict(profile.os.environ, {}, clear=True):
            first = threading.Thread(target=lambda: outcomes.append(profile.launch([], execute=execute)))
            later = threading.Thread(target=second)
            first.start()
            try:
                self.assertTrue(preparing.wait(1))
                later.start()
                self.assertTrue(requested.wait(1))
                self.assertEqual(calls, [])
            finally:
                finish.set()
                first.join(3)
                if later.ident is not None:
                    later.join(3)
            self.assertFalse(first.is_alive())
            self.assertFalse(later.is_alive())
        self.assertEqual(outcomes, [0, 0])
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][-1], 'https://example.test/')

    def test_lock_timeout_never_forwards_a_url_to_temporary_browser(self):
        runtime = tempfile.TemporaryDirectory(prefix='hn-home-', dir='/tmp')
        self.addCleanup(runtime.cleanup)
        endpoint = Path(runtime.name) / 'ready'
        execute = Mock()
        with patch.object(profile, 'startup_socket', return_value=endpoint), patch.object(profile.sys, 'stderr', io.StringIO()):
            with profile.startup_guard():
                self.assertEqual(profile.launch(['https://example.test/'], execute=execute, lock_timeout=.01), 1)
        execute.assert_not_called()


if __name__ == '__main__':
    unittest.main()
