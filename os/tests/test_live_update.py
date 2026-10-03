import hashlib
import fcntl
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('live_update', Path(__file__).parents[1] / 'live_update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


class FastUpdates(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.state, self.bundled = self.root / 'state', self.root / 'bundled'
        self.base = self.root / 'runtime.json'
        self.base.write_text('{"source_commit":"initial"}\n')
        self.bundled.mkdir()
        for name in update.FILES:
            (self.bundled / name).write_bytes(('old ' + name).encode())
        self.patches = [patch.object(update, 'STATE', self.state), patch.object(update, 'BUNDLED', self.bundled),
                        patch.object(update, 'BASE_ID', self.base),
                        patch.object(update, 'RESTART_REQUIRED', self.root / 'restart-required'),
                        patch.object(update, 'SYSTEM_LOCK', self.root / 'system.lock'),
                        patch.object(update, 'check_system', return_value={}),
                        patch.object(update, 'screen_ready'),
                        patch.object(update, 'notice'), patch.object(update, 'versions', side_effect=self.versions)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def versions(self, folder):
        return {component: '1.1.0' if (folder / name).read_bytes().startswith(b'new') else '1.0.0'
                for component, name in [('hn', 'harness-tui'), ('cli', 'cli.mjs')]}

    def feed(self, fail=None):
        assets = {name: ('new ' + name).encode() for name in update.FILES}
        refs = {name: dict(url='https://example.test/' + name, sha256=hashlib.sha256(data).hexdigest(), size=len(data))
                for name, data in assets.items()}
        manifests = {
            update.FEEDS['hn']: json.dumps(dict(version='1.1.0', builds={'linux-x64': refs['harness-tui']})).encode(),
            update.FEEDS['cli']: json.dumps(dict(cli=dict(version='1.1.0', cli=refs['cli.mjs'], notify=refs['notify.mjs']))).encode(),
        }
        def fetch(url, limit):
            if fail and fail in url:
                return b'broken download'
            return manifests[url] if url in manifests else assets[url.rsplit('/', 1)[1]]
        return patch.object(update, 'fetch', side_effect=fetch)

    def test_version_and_transport_reject_malformed_and_unsafe_releases(self):
        for value in ['1.0', '1.0.1-dev.local', '999999999.0.0', '../1.0.0', None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                update.version(value)
        for value in ['file:///etc/passwd', 'http://example.test/code', 'https://user:password@host/code', None]:
            with self.subTest(url=value), self.assertRaises(ValueError):
                update.allowed_url(value)
        self.assertEqual(update.allowed_url('http://127.0.0.1:19447/test'), 'http://127.0.0.1:19447/test')

    def test_background_check_stages_complete_release_without_activation_or_restarts(self):
        with self.feed(), patch.object(update, 'restart') as restart:
            self.assertTrue(update.check())
            target = update.prepared()
            record = update.verify(target)
            self.assertEqual(record['versions'], {'hn': '1.1.0', 'cli': '1.1.0'})
            self.assertEqual(update.selected(), self.bundled)
            restart.assert_not_called()
            self.assertEqual((self.bundled / 'harness-tui').read_bytes(), b'old harness-tui')
            self.assertTrue(update.check())
            self.assertEqual(update.prepared(), target)
            self.assertEqual(len(list((self.state / 'builds').iterdir())), 1)

    def test_bad_cli_hook_does_not_stage_half_a_pair_or_block_independent_hn(self):
        with self.feed(fail='notify.mjs'):
            self.assertTrue(update.check())
        target = update.prepared()
        self.assertEqual(update.verify(target)['versions'], {'hn': '1.1.0', 'cli': '1.0.0'})
        self.assertEqual((target / 'cli.mjs').read_bytes(), b'old cli.mjs')
        self.assertEqual((target / 'notify.mjs').read_bytes(), b'old notify.mjs')
        self.assertTrue(update.read(self.state / 'check.json')['errors'])

    def test_corrupt_hn_does_not_replace_current_build_and_valid_cli_can_still_stage(self):
        with self.feed(fail='harness-tui'):
            self.assertTrue(update.check())
        self.assertEqual(update.verify(update.prepared())['versions'], {'hn': '1.0.0', 'cli': '1.1.0'})
        self.assertEqual(update.selected(), self.bundled)

    def test_staged_file_changed_after_download_is_rejected_before_selection(self):
        with self.feed():
            update.check()
        (update.prepared() / 'cli.mjs').write_bytes(b'tampered')
        with patch.object(update, 'restart') as restart, self.assertRaisesRegex(ValueError, 'verification'):
            update.apply()
        restart.assert_not_called()
        self.assertEqual(update.selected(), self.bundled)

    def test_failed_activation_restores_previous_selection(self):
        with self.feed():
            update.check()
        error = subprocess.CalledProcessError(1, 'systemctl')
        with patch.object(update, 'restart', side_effect=[error, None]) as restart:
            with self.assertRaises(subprocess.CalledProcessError):
                update.apply()
            self.assertEqual(restart.call_count, 2)
        self.assertEqual(update.selected(), self.bundled)
        self.assertEqual(update.read(self.state / 'transaction.json')['status'], 'failed')

    def test_hn_only_activation_does_not_restart_the_daemon_and_rollback_holds_bad_version(self):
        with self.feed(fail='notify.mjs'):
            update.check()
        with patch.object(update, 'restart') as restart:
            update.apply()
            restart.assert_called_once_with(False)
        self.assertNotEqual(update.selected(), self.bundled)
        with patch.object(update, 'restart'):
            update.apply(rollback=True)
        self.assertEqual(update.selected(), self.bundled)
        self.assertEqual(update.read(self.state / 'ignored.json')['hn'], '1.1.0')
        with self.feed():
            update.check()
        self.assertEqual(update.verify(update.prepared())['versions']['hn'], '1.0.0')

    def test_concurrent_check_cannot_mutate_a_pending_transaction(self):
        with update.locked(), self.feed(), self.assertRaisesRegex(ValueError, 'already in progress'):
            update.check()
        self.assertFalse((self.state / 'ready.json').exists())

    def test_ready_pointer_cannot_escape_the_update_directory(self):
        self.state.mkdir()
        update.write(self.state / 'ready.json', {'id': '../../other'})
        with self.assertRaises(ValueError):
            update.prepared()

    def test_new_os_package_uses_its_matching_runtime_until_a_fresh_update_is_prepared(self):
        with self.feed(), patch.object(update, 'restart'):
            update.check()
            update.apply()
        self.assertNotEqual(update.selected(), self.bundled)
        self.base.write_text('{"source_commit":"next-os-build"}\n')
        self.assertEqual(update.selected(), self.bundled)
        with self.feed(), patch.object(update, 'restart'):
            update.check()
            update.apply()
        self.assertNotEqual(update.selected(), self.bundled)

    def test_old_downloads_are_removed_but_unknown_files_are_preserved(self):
        with self.feed():
            update.check()
        builds = self.state / 'builds'
        for name in ['a' * 64, '.download-interrupted', 'user-notes']:
            (builds / name).mkdir()
        with update.locked():
            update.prune()
        self.assertFalse((builds / ('a' * 64)).exists())
        self.assertFalse((builds / '.download-interrupted').exists())
        self.assertTrue((builds / 'user-notes').is_dir())
        self.assertTrue(update.prepared().exists())

    def test_interrupted_selection_recovers_before_another_background_check(self):
        with self.feed():
            update.check()
        target = update.prepared()
        update.write(self.state / 'transaction.json', {'status': 'applying', 'previous': str(self.bundled), 'target': str(target)})
        update.select(target)
        with self.feed(), patch.object(update, 'restart') as restart:
            update.check()
        restart.assert_called_once_with(True)
        self.assertEqual(update.selected(), self.bundled)
        self.assertEqual(update.read(self.state / 'transaction.json')['status'], 'interrupted')

    def test_ready_service_with_no_attached_client_rolls_back(self):
        with self.feed():
            update.check()
        with patch.object(update, 'screen_ready', side_effect=ValueError('No attached client')), patch.object(update, 'restart'):
            with self.assertRaisesRegex(ValueError, 'No attached client'):
                update.apply()
        self.assertEqual(update.selected(), self.bundled)

    def test_system_update_holds_fast_updates_until_reboot(self):
        update.RESTART_REQUIRED.write_text('{"status":"ready"}')
        with patch.object(update, 'fetch', side_effect=AssertionError('No download before restart')):
            self.assertFalse(update.check())
        with self.assertRaisesRegex(ValueError, 'Restart'):
            update.apply()

    def test_root_system_transaction_excludes_fast_activation(self):
        with update.SYSTEM_LOCK.open('w') as root_lock:
            fcntl.flock(root_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, 'system update is in progress'):
                with update.locked():
                    self.fail('The root transaction must hold this lock exclusively')

    def test_new_os_base_does_not_delete_runtime_used_by_the_running_old_session(self):
        with self.feed(), patch.object(update, 'restart'):
            update.check()
            update.apply()
        old_runtime = update.selected()
        self.base.write_text('{"source_commit":"new-os"}\n')
        with update.locked():
            update.prune()
        self.assertTrue(old_runtime.is_dir())


if __name__ == '__main__':
    unittest.main()
