import hashlib
import curses
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
                        patch.object(update, 'BOOT_ID', self.root / 'boot-id'),
                        patch.object(update, 'RESTART_REQUIRED', self.root / 'restart-required'),
                        patch.object(update, 'SYSTEM_LOCK', self.root / 'system.lock'),
                        patch.object(update, 'check_system', return_value={}),
                        patch.object(update, 'screen_ready'),
                        patch.object(update, 'notice'), patch.object(update, 'versions', side_effect=self.versions)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        update.BOOT_ID.write_text('first-boot')

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

    def test_public_release_already_included_in_os_source_cannot_replace_newer_fixes(self):
        self.base.write_text(json.dumps({'source_commit': 'source-built',
                                        'release_baselines': {'cli': {'version': '1.1.0', 'commit': 'a' * 40}}}))
        with self.feed():
            self.assertTrue(update.check())
        # The independent TUI update still arrives; the older public CLI does not.
        ready = update.verify(update.prepared())
        self.assertEqual(ready['versions'], {'hn': '1.1.0', 'cli': '1.0.0'})
        self.assertEqual((update.prepared() / 'cli.mjs').read_bytes(), b'old cli.mjs')
        self.assertEqual((update.prepared() / 'notify.mjs').read_bytes(), b'old notify.mjs')

    def test_release_newer_than_the_os_source_baseline_is_still_downloaded(self):
        self.base.write_text(json.dumps({'release_baselines': {'cli': {'version': '1.0.5', 'commit': 'a' * 40}}}))
        with self.feed():
            self.assertTrue(update.check())
        self.assertEqual(update.verify(update.prepared())['versions']['cli'], '1.1.0')

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
        with self.feed(), patch.object(update, 'restart') as restart:
            self.assertTrue(update.check())
            self.assertEqual(update.verify(update.prepared())['versions'], {'hn': '1.1.0', 'cli': '1.1.0'})
            self.assertEqual(update.selected(), self.bundled)
            restart.assert_not_called()
            update.apply()
        self.assertNotEqual(update.selected(), self.bundled)

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

    def show(self, keys, mouse=None, refresh=False):
        class Window:
            def __init__(self): self.drawn, self.keys = [], iter(keys)
            def keypad(self, _): pass
            def timeout(self, _): pass
            def getmaxyx(self): return 30, 90
            def erase(self): self.drawn.clear()
            def refresh(self): pass
            def addnstr(self, row, col, text, length, style): self.drawn.append((row, col, text[:length]))
            def getch(self): return next(self.keys)
        window = Window()
        def event():
            row, col, text = next(item for item in window.drawn if item[2] == '[ Update ]')
            return 0, col + (2 if mouse == 'inside' else len(text) + 1), row, 0, curses.BUTTON1_CLICKED
        with patch.object(update.curses, 'curs_set'), patch.object(update.curses, 'has_colors', return_value=False), \
             patch.object(update.curses, 'mousemask'), patch.object(update.curses, 'mouseinterval'), \
             patch.object(update.curses, 'getmouse', side_effect=event):
            return update.screen(window, refresh=refresh)

    def test_update_button_click_and_keyboard_use_the_same_action_without_a_confirmation(self):
        with self.feed(): update.check()
        self.assertEqual(self.show([10]), 'update')
        self.assertEqual(self.show([curses.KEY_MOUSE], mouse='inside'), 'update')
        self.assertIsNone(self.show([curses.KEY_MOUSE, 27], mouse='outside'))
        self.assertIsNone(self.show([27]))
        self.assertEqual(update.selected(), self.bundled)

    def test_shortcut_request_starts_update_without_waiting_for_a_key(self):
        with self.feed(): update.check()
        update.write(self.state / 'request.json', {'requested_at': 1})
        self.assertEqual(self.show([]), 'update')
        self.assertFalse((self.state / 'request.json').exists())

    def test_restart_is_never_the_default_action_or_triggered_by_update_shortcut(self):
        self.state.mkdir()
        update.RESTART_REQUIRED.write_text('{"status":"ready"}')
        update.write(self.state / 'request.json', {'requested_at': 1})
        self.assertIsNone(self.show([10]))
        self.assertEqual(self.show([curses.KEY_RIGHT, 10]), 'reboot')

    def test_one_action_uses_exact_passwordless_system_command_and_defers_runtime_until_reboot(self):
        with self.feed(): update.check()
        update.write(self.state / 'system.json', {'available': True})
        def system(args, **kwargs):
            self.assertEqual(args, ['sudo', '-n', '/usr/bin/harness', 'upgrade'])
            self.assertTrue(kwargs['check'])
            update.RESTART_REQUIRED.write_text('{"status":"ready"}')
        with patch.object(update.subprocess, 'run', side_effect=system), patch.object(update, 'apply') as apply:
            update.update_all()
            update.finish_approved_update()
            apply.assert_not_called()
        self.assertEqual(update.read(self.state / 'approved.json')['status'], 'after-reboot')
        update.RESTART_REQUIRED.unlink()
        update.BOOT_ID.write_text('second-boot')
        with patch.object(update, 'restart') as restart:
            update.finish_approved_update()
            self.assertEqual(restart.call_count, 1)
            update.finish_approved_update()
            self.assertEqual(restart.call_count, 1)
        self.assertFalse((self.state / 'approved.json').exists())

    def test_failed_privileged_update_does_not_authorize_later_activation(self):
        self.state.mkdir()
        update.write(self.state / 'system.json', {'available': True})
        with patch.object(update.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'sudo')):
            with self.assertRaises(subprocess.CalledProcessError): update.update_all()
        self.assertFalse((self.state / 'approved.json').exists())

    def test_later_timer_cannot_activate_without_a_request_or_after_base_changes(self):
        with self.feed(): update.check()
        with patch.object(update, 'apply') as apply:
            update.finish_approved_update()
            apply.assert_not_called()
        update.write(self.state / 'approved.json', {'status':'after-reboot', 'boot_id':'earlier', 'base_sha256':'changed'})
        with patch.object(update, 'apply') as apply, self.assertRaisesRegex(ValueError, 'system changed'):
            update.finish_approved_update()
        apply.assert_not_called()
        self.assertEqual(update.read(self.state / 'approved.json')['status'], 'failed')

    def test_explicit_recheck_clears_failed_completion_when_no_updates_remain(self):
        self.state.mkdir()
        update.write(self.state / 'approved.json', {'status': 'failed'})
        with patch.object(update, 'check', return_value=False):
            self.assertIsNone(self.show([10], refresh=True))
        self.assertFalse((self.state / 'approved.json').exists())

    def test_retry_keeps_the_request_so_recovered_downloads_apply_without_another_key(self):
        with patch.object(update.os, 'geteuid', return_value=1000), \
             patch.object(update.curses, 'wrapper', side_effect=['check', None]):
            update.main(['screen'])
        self.assertTrue((self.state / 'request.json').exists())
        with self.feed():
            self.assertEqual(self.show([], refresh=True), 'update')
        self.assertFalse((self.state / 'request.json').exists())


if __name__ == '__main__':
    unittest.main()
