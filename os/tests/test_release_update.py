import copy
from contextlib import nullcontext
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('release_update', Path(__file__).parents[1] / 'release_update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class ReleaseChannel(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.lock = self.root / 'lock.json'
        self.base = dict(version='0.1.0-preview.4', arch_snapshot='2026/10/01')
        self.lock.write_text(json.dumps(self.base))
        self.patch = patch.object(update, 'LOCK', self.lock)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.content = {}
        content = self.content
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path not in content:
                    self.send_error(404)
                    return
                data = content[self.path]
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def log_message(self, *args):
                pass
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        self.package = b'private package fixture'
        self.manifest = dict(schema=1, kind='harness-os-package', architecture='x86_64',
            requires_os_version=self.base['version'], arch_snapshot=self.base['arch_snapshot'],
            package=dict(name='harness-os-0.1.0pre4.r2-1-x86_64.pkg.tar.gz', version='0.1.0pre4.r2-1',
                         bytes=len(self.package), sha256=hashlib.sha256(self.package).hexdigest()))
        self.publish()
        self.commands = patch.object(update.subprocess, 'check_output', side_effect=lambda args, **kw:
            'harness-os 0.1.0pre4-1\n' if args[0] == 'pacman' else '1\n')
        self.commands.start()
        self.addCleanup(self.commands.stop)

    def publish(self):
        manifest = json.dumps(self.manifest).encode()
        self.metadata = dict(schema=1, channel='preview', architecture='x86_64',
            manifest=dict(url=self.url + '/manifest.json', bytes=len(manifest), sha256=hashlib.sha256(manifest).hexdigest()),
            package=dict(url=self.url + '/package.pkg.tar.gz', bytes=len(self.package), sha256=hashlib.sha256(self.package).hexdigest()))
        self.content.update({'/metadata.json': json.dumps(self.metadata).encode(), '/manifest.json': manifest,
                             '/package.pkg.tar.gz': self.package})

    def test_actual_http_discovery_verifies_manifest_and_does_not_download_or_install_the_package(self):
        del self.content['/package.pkg.tar.gz']
        result = update.discover(self.url + '/metadata.json')
        self.assertTrue(result['available'])
        self.assertEqual(result['version'], self.manifest['package']['version'])
        with patch.object(update.subprocess, 'check_output', side_effect=['harness-os 0.1.0pre4.r3-1', '-1']):
            self.assertFalse(update.discover(self.url + '/metadata.json')['available'])

    def test_existing_feed_discovers_an_official_release_without_reconfiguring_the_client(self):
        self.manifest['requires_os_version'] = '0.1.0'
        self.manifest['upgrades_from'] = [self.base]
        self.manifest['package'].update(name='harness-os-0.1.0-1-x86_64.pkg.tar.gz', version='0.1.0-1')
        self.publish()
        result = update.discover(self.url + '/metadata.json')
        self.assertTrue(result['available'])
        self.assertEqual(result['version'], '0.1.0-1')
        self.assertEqual(self.metadata['channel'], 'preview')

    def test_missing_channel_is_empty_but_invalid_or_truncated_channel_is_an_error(self):
        self.assertIsNone(update.discover(self.url + '/missing'))
        original = copy.deepcopy(self.metadata)
        for field, value in [('architecture', 'aarch64'), ('schema', 2), ('channel', 'stable')]:
            self.content['/metadata.json'] = json.dumps(dict(original, **{field: value})).encode()
            with self.subTest(field=field), self.assertRaises(ValueError):
                update.discover(self.url + '/metadata.json')
        self.publish()
        self.content['/manifest.json'] = self.content['/manifest.json'][:-1]
        with self.assertRaisesRegex(ValueError, 'checksum or size'):
            update.discover(self.url + '/metadata.json')

    def test_unrelated_repository_and_unbounded_asset_are_rejected(self):
        for url in ['https://github.com/other/repository/releases/download/test/file',
                    'https://github.com.evil.test/autonomous-ai/openharness/releases/download/file',
                    'http://example.test/file', 'file:///etc/passwd']:
            ref = dict(self.metadata['package'], url=url)
            with self.subTest(url=url), self.assertRaises(ValueError):
                update.asset(ref, 128 * 1024 * 1024)
        for size in [True, -1, 0, 128 * 1024 * 1024 + 1]:
            with self.subTest(size=size), self.assertRaises(ValueError):
                update.asset(dict(self.metadata['package'], bytes=size), 128 * 1024 * 1024, fixture=True)

    def test_migration_must_explicitly_include_the_installed_base(self):
        self.manifest['requires_os_version'] = '0.1.0-preview.5'
        self.publish()
        with self.assertRaisesRegex(ValueError, 'different Harness base'):
            update.discover(self.url + '/metadata.json')
        self.manifest['upgrades_from'] = [self.base]
        self.publish()
        self.assertTrue(update.discover(self.url + '/metadata.json')['available'])
        self.manifest['upgrades_from'] = []
        self.publish()
        with patch.object(update.subprocess, 'check_output', side_effect=['harness-os 0.1.0pre6-1', '-1']):
            self.assertFalse(update.discover(self.url + '/metadata.json')['available'])

    def fake_updater(self):
        config = self.root / 'pacman.conf'
        config.write_text('Server = https://archive.archlinux.org/repos/2026/09/30/$repo/os/$arch\n')
        self.events = []
        system = SimpleNamespace(operation_lock=lambda: nullcontext(), installed=lambda: {'root_uuid': 'fixture'},
            snapshot_date=lambda date: date, PACMAN_CONFIG=config, pending_update=lambda: None,
            update=lambda date, **options: self.events.append(('system', date, options)))
        def apply(folder, system, base, installation):
            self.assertEqual((folder / self.manifest['package']['name']).read_bytes(), self.package)
            self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
            self.events.append(('harness', folder))
        return SimpleNamespace(system_module=lambda: system, validate_bundle=Mock(),
            prepare_kernel_bundle=Mock(),
            validate_base=update.load_runtime_updater().validate_base, latest=lambda: None, apply=apply)

    def test_root_download_is_private_and_full_base_upgrade_precedes_package_application(self):
        updater = self.fake_updater()
        with patch.object(update.os, 'geteuid', return_value=0), patch.object(update, 'load_runtime_updater', return_value=updater):
            update.apply(self.url + '/metadata.json')
        self.assertEqual(self.events[0], ('system', '2026/10/01', {'noninteractive': True}))
        self.assertEqual(self.events[1][0], 'harness')
        self.assertFalse(self.events[1][1].exists(), 'Root download is removed after the transaction')
        updater.validate_bundle.assert_called_once()

    def test_corrupt_package_never_touches_the_system(self):
        updater = self.fake_updater()
        self.content['/package.pkg.tar.gz'] = b'wrong package'
        with patch.object(update.os, 'geteuid', return_value=0), patch.object(update, 'load_runtime_updater', return_value=updater):
            with self.assertRaisesRegex(ValueError, 'checksum or size'):
                update.apply(self.url + '/metadata.json')
        self.assertEqual(self.events, [])
        updater.validate_bundle.assert_not_called()

    def test_kernel_preparation_failure_leaves_arch_and_harness_unchanged(self):
        updater = self.fake_updater()
        updater.prepare_kernel_bundle.side_effect = ValueError('T2 kernel download failed verification')
        with patch.object(update.os, 'geteuid', return_value=0), patch.object(update, 'load_runtime_updater', return_value=updater):
            with self.assertRaisesRegex(ValueError, 'T2 kernel download'):
                update.apply(self.url + '/metadata.json')
        self.assertEqual(self.events, [])

    def test_public_base_upgrade_completes_without_terminal_input(self):
        updater = self.fake_updater()
        public_system = updater.system_module()
        spec = importlib.util.spec_from_file_location('release_system', Path(update.__file__).with_name('system.py'))
        system = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(system)
        system.PACMAN_CONFIG = public_system.PACMAN_CONFIG
        system.UPDATE_RECEIPT = self.root / 'update.json'
        system.checkpoint = Mock(return_value='original-checkpoint')
        public_system.update = system.update
        prompt = self.root / 'pacman-prompt.py'
        # Model pacman's documented --noconfirm contract with an actual child
        # that otherwise waits for stdin, like the inherited Updates terminal.
        prompt.write_text('''import os, sys
assert os.environ['HN_OS_UPDATE_CHECKPOINT'] == '1'
if '--noconfirm' not in sys.argv:
    print('Proceed with installation? [Y/n]', flush=True)
    answer = sys.stdin.readline()
    sys.exit(0 if answer and answer.strip().lower() in ('', 'y', 'yes') else 1)
assert sys.stdin.read() == '', 'Scripted updates must not consume terminal input'
''')
        run = subprocess.run
        read_fd, write_fd = os.pipe()
        def pacman(argv, **kwargs):
            self.assertEqual(argv[:2], ['pacman', '-Syyu'])
            if kwargs.get('stdin') is None:
                kwargs['stdin'] = read_fd
            return run([sys.executable, str(prompt), *argv[1:]],
                       capture_output=True, text=True, timeout=2, **kwargs)
        try:
            with patch.object(update.os, 'geteuid', return_value=0), \
                    patch.object(update, 'load_runtime_updater', return_value=updater), \
                    patch.object(system.subprocess, 'run', side_effect=pacman):
                update.apply(self.url + '/metadata.json')
        finally:
            os.close(read_fd)
            os.close(write_fd)
        system.checkpoint.assert_called_once_with('before-update')
        receipt = json.loads(system.UPDATE_RECEIPT.read_text())
        self.assertEqual((receipt['exit_status'], receipt['checkpoint']), (0, 'original-checkpoint'))
        self.assertEqual(self.events[0][0], 'harness')

    def test_failed_harness_transaction_blocks_advancing_the_arch_base(self):
        updater = self.fake_updater()
        updater.latest = lambda: {'status': 'failed'}
        with patch.object(update.os, 'geteuid', return_value=0), patch.object(update, 'load_runtime_updater', return_value=updater):
            with self.assertRaisesRegex(ValueError, 'Restore the previous'):
                update.apply(self.url + '/metadata.json')
        self.assertEqual(self.events, [])


if __name__ == '__main__':
    unittest.main()
