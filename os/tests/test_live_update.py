import hashlib
import curses
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('live_update', Path(__file__).parents[1] / 'live_update.py')
update = importlib.util.module_from_spec(spec)
spec.loader.exec_module(update)


def elf_fixture(machine=62, payload=b''):
    """A synthetic ELF header; version execution is stubbed in staging tests."""
    return struct.pack('<16sHHIQQQIHHHHHH', b'\x7fELF\x02\x01\x01' + b'\0' * 9,
                       2, machine, 1, 0, 64, 0, 0, 64, 56, 0, 0, 0, 0) + payload


class Response(io.BytesIO):
    def __init__(self, data, url='https://example.test/runtime', headers=None):
        super().__init__(data)
        self.url, self.headers, self.reads = url, headers or {}, []

    def read(self, size=-1):
        self.reads.append(size)
        return super().read(size)


class Downloads(unittest.TestCase):
    def test_large_release_is_streamed_in_bounded_reads(self):
        data = b'payload' * 400000
        for declared_size in (True, False):
            with self.subTest(declared_size=declared_size), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / 'runtime'
                ref = {'url': 'https://example.test/runtime', 'sha256': hashlib.sha256(data).hexdigest()}
                if declared_size:
                    ref['size'] = len(data)
                response = Response(data)
                with patch.object(update, 'urlopen', return_value=response):
                    update.download(ref, target)
                self.assertEqual(target.read_bytes(), data)
                self.assertGreater(len(response.reads), 2)
                self.assertTrue(all(0 < size <= 1024 * 1024 for size in response.reads))

    def test_invalid_downloads_leave_no_partial_file(self):
        data = b'payload'
        correct = hashlib.sha256(data).hexdigest()
        cases = [
            ({'size': len(data) - 1}, {}),  # Oversize without Content-Length.
            ({'size': len(data) + 1}, {}),  # Truncated with a correct checksum.
            ({'sha256': '0' * 64}, {}),
            ({}, {'Content-Length': 'invalid'}),
            ({'size': len(data)}, {'Content-Length': str(len(data) + 1)}),
        ]
        for fields, headers in cases:
            with self.subTest(fields=fields, headers=headers), tempfile.TemporaryDirectory() as temp:
                target = Path(temp) / 'runtime'
                ref = dict({'url': 'https://example.test/runtime', 'sha256': correct}, **fields)
                with patch.object(update, 'urlopen', return_value=Response(data, headers=headers)):
                    with self.assertRaises(ValueError):
                        update.download(ref, target)
                self.assertFalse(target.exists())
        with tempfile.TemporaryDirectory() as temp, patch.object(update, 'LIMIT', len(data) - 1):
            target = Path(temp) / 'runtime'
            with patch.object(update, 'urlopen', return_value=Response(data)), self.assertRaises(ValueError):
                update.download({'url': 'https://example.test/runtime', 'sha256': correct}, target)
            self.assertFalse(target.exists())

    def test_stream_failure_cleans_its_file_but_never_removes_an_existing_file(self):
        ref = {'url': 'https://example.test/runtime', 'sha256': '0' * 64}
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'runtime'
            response = Response(b'')
            with (patch.object(response, 'read', side_effect=[b'partial', OSError('connection lost')]),
                  patch.object(update, 'urlopen', return_value=response), self.assertRaises(OSError)):
                update.download(ref, target)
            self.assertFalse(target.exists())
            target.write_bytes(b'existing')
            with patch.object(update, 'urlopen', return_value=Response(b'')), self.assertRaises(FileExistsError):
                update.download(ref, target)
            self.assertEqual(target.read_bytes(), b'existing')

    def test_unsafe_redirect_is_rejected_before_creating_a_file(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'runtime'
            with (patch.object(update, 'urlopen', return_value=Response(b'', url='http://example.test/runtime')),
                  self.assertRaisesRegex(ValueError, 'HTTPS')):
                update.download({'url': 'https://example.test/runtime', 'sha256': '0' * 64}, target)
            self.assertFalse(target.exists())


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
            data = ('old ' + name).encode()
            (self.bundled / name).write_bytes(elf_fixture(payload=data) if name == 'harness-tui' else data)
        self.patches = [patch.object(update, 'STATE', self.state), patch.object(update, 'BUNDLED', self.bundled),
                        patch.object(update, 'BASE_ID', self.base),
                        patch.object(update, 'BOOT_ID', self.root / 'boot-id'),
                        patch.object(update, 'RESTART_REQUIRED', self.root / 'restart-required'),
                        patch.object(update, 'SYSTEM_LOCK', self.root / 'system.lock'),
                        patch.object(update.platform, 'system', return_value='Linux'),
                        patch.object(update.platform, 'machine', return_value='x86_64'),
                        patch.object(update, 'check_system', return_value={}),
                        patch.object(update, 'screen_ready'),
                        patch.object(update, 'capture_view', return_value=None),
                        patch.object(update, 'notice'), patch.object(update, 'versions', side_effect=self.versions)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)
        update.BOOT_ID.write_text('first-boot')

    def versions(self, folder):
        return {component: '1.1.0' if (folder / name).read_bytes().endswith(('new ' + name).encode()) else '1.0.0'
                for component, name in [('hn', 'harness-tui'), ('cli', 'cli.mjs')]}

    def feed(self, fail=None, target='linux-x64', machine=62):
        assets = {name: ('new ' + name).encode() for name in update.FILES}
        assets['harness-tui'] = elf_fixture(machine, assets['harness-tui'])
        refs = {name: dict(url='https://example.test/' + name, sha256=hashlib.sha256(data).hexdigest(), size=len(data))
                for name, data in assets.items()}
        manifests = {
            update.FEEDS['hn']: json.dumps(dict(version='1.1.0', builds={target: refs['harness-tui']})).encode(),
            update.FEEDS['cli']: json.dumps(dict(cli=dict(version='1.1.0', cli=refs['cli.mjs'], notify=refs['notify.mjs']))).encode(),
        }
        def fetch(request, timeout):
            url = request.full_url
            if fail and fail in url:
                return Response(b'broken download', url)
            return Response(manifests[url] if url in manifests else assets[url.rsplit('/', 1)[1]], url)
        return patch.object(update, 'urlopen', side_effect=fetch)

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
            self.assertEqual((self.bundled / 'harness-tui').read_bytes(), elf_fixture(payload=b'old harness-tui'))
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

    def test_interrupted_download_check_cleans_staging_without_publishing(self):
        def progress(message):
            if message == 'Downloading Harness…':
                raise KeyboardInterrupt()
        with self.feed(), self.assertRaises(KeyboardInterrupt):
            update.check(progress=progress)
        self.assertIsNone(update.prepared())
        self.assertEqual(update.selected(), self.bundled)
        self.assertEqual(list((self.state / 'builds').iterdir()), [])

    def test_corrupt_hn_does_not_replace_current_build_and_valid_cli_can_still_stage(self):
        with self.feed(fail='harness-tui'):
            self.assertTrue(update.check())
        self.assertEqual(update.verify(update.prepared())['versions'], {'hn': '1.0.0', 'cli': '1.1.0'})
        self.assertEqual(update.selected(), self.bundled)

    def test_arm_stages_native_hn_and_cli_without_activation(self):
        (self.bundled / 'harness-tui').write_bytes(elf_fixture(183, b'old harness-tui'))
        with patch.object(update.platform, 'machine', return_value='aarch64'), self.feed(target='linux-arm64', machine=183), patch.object(update, 'restart') as restart:
            self.assertTrue(update.check())
            self.assertEqual(update.verify(update.prepared())['versions'], {'hn': '1.1.0', 'cli': '1.1.0'})
            self.assertEqual((update.prepared() / 'harness-tui').read_bytes(), elf_fixture(183, b'new harness-tui'))
            self.assertEqual(update.selected(), self.bundled)
            restart.assert_not_called()

    def test_missing_arm_release_keeps_hn_but_allows_independent_cli(self):
        original = elf_fixture(183, b'old harness-tui')
        (self.bundled / 'harness-tui').write_bytes(original)
        with patch.object(update.platform, 'machine', return_value='aarch64'), self.feed() as fetch:
            self.assertTrue(update.check())
        self.assertEqual(update.verify(update.prepared())['versions'], {'hn': '1.0.0', 'cli': '1.1.0'})
        self.assertEqual((update.prepared() / 'harness-tui').read_bytes(), original)
        self.assertNotIn('https://example.test/harness-tui', [call.args[0].full_url for call in fetch.call_args_list])
        self.assertIn('No hn build is available for linux-arm64', str(update.read(self.state / 'check.json')['errors']))
        self.assertEqual(update.selected(), self.bundled)

    def test_wrong_architecture_with_valid_checksum_keeps_hn_but_allows_cli(self):
        original = elf_fixture(183, b'old harness-tui')
        (self.bundled / 'harness-tui').write_bytes(original)
        # The manifest is correctly named and checksummed, but the payload is x86.
        with patch.object(update.platform, 'machine', return_value='aarch64'), self.feed(target='linux-arm64'):
            self.assertTrue(update.check())
        self.assertEqual(update.verify(update.prepared())['versions'], {'hn': '1.0.0', 'cli': '1.1.0'})
        self.assertEqual((update.prepared() / 'harness-tui').read_bytes(), original)
        self.assertIn('does not match this computer (linux-arm64)', str(update.read(self.state / 'check.json')['errors']))
        self.assertEqual(update.selected(), self.bundled)

    def test_unusable_hn_only_feed_does_not_prepare_or_activate_an_update(self):
        (self.bundled / 'harness-tui').write_bytes(elf_fixture(183, b'old harness-tui'))
        for target in ['linux-x64', 'linux-arm64']:
            # The ARM entry, when present, deliberately contains an x86 binary.
            with (self.subTest(target=target), patch.object(update.platform, 'machine', return_value='aarch64'),
                  self.feed(target=target), patch.object(update, 'restart') as restart):
                with self.assertRaisesRegex(ValueError, 'Could not check for updates'):
                    update.check(feeds={'hn': update.FEEDS['hn']})
                self.assertIsNone(update.prepared())
                self.assertEqual(update.selected(), self.bundled)
                restart.assert_not_called()

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

    def show(self, keys, mouse=None, refresh=False, retry=False):
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
            return update.screen(window, refresh=refresh, retry=retry)

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

    def test_targeted_request_is_inert_in_other_owned_or_direct_inspection(self):
        with self.feed(): update.check()
        request = dict(requested_at=1, target='a' * 32)
        update.write(self.state / 'request.json', request)
        for env in [{}, {'HARNESS_UPDATE_INSTANCE': 'b' * 32}]:
            with self.subTest(env=env), patch.dict(os.environ, env, clear=True):
                self.assertIsNone(self.show([27]))
                self.assertEqual(update.read(self.state / 'request.json'), request)
        with patch.dict(os.environ, {'HARNESS_UPDATE_INSTANCE': 'a' * 32}, clear=True):
            self.assertEqual(self.show([]), 'update')
        self.assertFalse((self.state / 'request.json').exists())

    def test_request_claim_holds_handoff_lock_through_match_and_unlink(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading
        self.state.mkdir()
        first, second = dict(requested_at=1, target='a' * 32), dict(requested_at=2, target='b' * 32)
        update.write(self.state / 'request.json', first)
        matched, publishing, published = threading.Event(), threading.Event(), threading.Event()
        predicate = update.request_for_screen
        def match():
            result = predicate()
            matched.set()
            self.assertTrue(publishing.wait(timeout=2))
            self.assertFalse(published.is_set())
            return result
        def publish():
            self.assertTrue(matched.wait(timeout=2))
            with (self.state / 'open.lock').open('a') as lock:
                publishing.set()
                fcntl.flock(lock, fcntl.LOCK_EX)
                update.write(self.state / 'request.json', second)
                published.set()
        with (patch.dict(os.environ, {'HARNESS_UPDATE_INSTANCE': 'a' * 32}, clear=True),
              patch.object(update, 'request_for_screen', side_effect=match),
              ThreadPoolExecutor(max_workers=1) as pool):
            future = pool.submit(publish)
            self.assertTrue(update.consume_request())
            future.result(timeout=2)
        self.assertEqual(update.read(self.state / 'request.json'), second)

    def test_explicit_request_stays_compatible_and_private_target_is_validated(self):
        with patch.object(update.os, 'geteuid', return_value=1000), patch.dict(os.environ, {}, clear=True):
            update.main(['request'])
            self.assertEqual(set(update.read(self.state / 'request.json')), {'requested_at'})
            with patch.dict(os.environ, {'HARNESS_UPDATE_TARGET': 'c' * 32}):
                update.main(['request'])
            self.assertEqual(update.read(self.state / 'request.json')['target'], 'c' * 32)
            with patch.dict(os.environ, {'HARNESS_UPDATE_TARGET': 'invalid'}), self.assertRaisesRegex(ValueError, 'target'):
                update.main(['request'])
            self.assertEqual(update.read(self.state / 'request.json')['target'], 'c' * 32)

    def test_shortcut_after_last_poll_prevents_close_and_needs_no_second_key(self):
        with self.feed(): update.check()
        def keys():
            # The screen has polled request.json already. Super+u arrives just
            # before an older Escape is handled, while the process is alive.
            update.write(self.state / 'request.json', dict(requested_at=2, target='a' * 32))
            yield 27
            self.fail('The pending shortcut needed another key')
        with patch.dict(os.environ, {'HARNESS_UPDATE_INSTANCE': 'a' * 32}, clear=True):
            self.assertEqual(self.show(keys()), 'update')
        self.assertFalse((self.state / 'request.json').exists())

    def test_screen_registration_ends_before_close_returns_even_if_process_is_alive(self):
        proc = self.root / 'proc'
        pid = os.getpid()
        (proc / str(pid)).mkdir(parents=True)
        (proc / str(pid) / 'stat').write_text(f'{pid} (python) ' + ' '.join(['S'] + ['0'] * 18 + ['123']))
        with (patch.object(update, 'PROC', proc),
              patch.dict(os.environ, {'HARNESS_UPDATE_INSTANCE': 'a' * 32}, clear=True)):
            with update.screen_registration():
                record = update.read(self.state / 'screens' / str(pid))
                self.assertEqual(record, dict(pid=pid, start='123', token='a' * 32, boot_id='first-boot'))
                self.assertTrue(update.close_screen())
                self.assertFalse((self.state / 'screens' / str(pid)).exists())
                self.assertEqual(os.getpid(), pid)  # Still before context/process cleanup.

    def test_unowned_terminal_screen_does_not_register_a_backend_pane_as_ui_identity(self):
        with patch.dict(os.environ, {'TMUX_PANE': '%7', 'HN_SOCKET': '/tmp/hn/default.sock'}, clear=True):
            with update.screen_registration():
                self.assertFalse((self.state / 'screens' / str(os.getpid())).exists())

    def test_close_waits_for_shortcut_handoff_then_preserves_its_pending_intent(self):
        from concurrent.futures import ThreadPoolExecutor
        import threading
        self.state.mkdir()
        marker = self.state / 'screens' / str(os.getpid())
        marker.parent.mkdir()
        marker.write_text('{}')
        entering = threading.Event()
        def close():
            entering.set()
            return update.close_screen()
        with (self.state / 'open.lock').open('a') as lock, ThreadPoolExecutor(max_workers=1) as pool:
            fcntl.flock(lock, fcntl.LOCK_EX)
            future = pool.submit(close)
            self.assertTrue(entering.wait(timeout=2))
            update.write(self.state / 'request.json', {'requested_at': 3})
            self.assertFalse(future.done())
            fcntl.flock(lock, fcntl.LOCK_UN)
            self.assertFalse(future.result(timeout=2))
        self.assertTrue(marker.exists())
        self.assertTrue((self.state / 'request.json').exists())

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

    def test_manual_retry_stays_local_and_applies_recovered_download_without_another_key(self):
        self.state.mkdir()
        other = dict(requested_at=1, target='b' * 32)
        update.write(self.state / 'request.json', other)
        with patch.dict(os.environ, {}, clear=True), patch.object(update.os, 'geteuid', return_value=1000), \
             patch.object(update.curses, 'wrapper', side_effect=['check', None]) as wrapper:
            update.main(['screen'])
        self.assertTrue(wrapper.call_args_list[1].args[3])
        self.assertEqual(update.read(self.state / 'request.json'), other)
        with self.feed(), patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.show([], refresh=True, retry=True), 'update')
        self.assertEqual(update.read(self.state / 'request.json'), other)


class RuntimeArchitecture(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        for item in [patch.object(update.platform, 'system', return_value='Linux'),
                     patch.object(update.platform, 'machine', return_value='x86_64')]:
            item.start()
            self.addCleanup(item.stop)

    def test_release_uses_exact_native_asset_when_both_architectures_exist(self):
        refs = {key: {'url': f'https://example.test/{key}', 'sha256': str(index) * 64}
                for index, key in enumerate(['linux-x64', 'linux-arm64'], 1)}
        manifest = json.dumps({'version': '1.2.3', 'builds': refs}).encode()
        for machine, key in [('x86_64', 'linux-x64'), ('aarch64', 'linux-arm64')]:
            with self.subTest(machine=machine), patch.object(update.platform, 'machine', return_value=machine), patch.object(update, 'fetch', return_value=manifest):
                self.assertEqual(update.release('https://example.test/feed', 'hn'),
                                 ('1.2.3', {'harness-tui': refs[key]}))

    def test_unsupported_platforms_never_fall_back_to_x86(self):
        for system, machine in [('Linux', 'armv7l'), ('Linux', 'riscv64'), ('Darwin', 'arm64')]:
            with self.subTest(system=system, machine=machine), patch.object(update.platform, 'system', return_value=system), patch.object(update.platform, 'machine', return_value=machine):
                with self.assertRaisesRegex(ValueError, 'require x86-64 or ARM64 Linux'):
                    update.runtime_platform()

    def test_matching_elf_version_probes_run_on_each_native_platform(self):
        for machine, elf_machine, elf_type in [('x86_64', 62, 2), ('aarch64', 183, 2), ('aarch64', 183, 3)]:
            header = bytearray(elf_fixture(elf_machine))
            header[16:18] = elf_type.to_bytes(2, 'little')
            (self.root / 'harness-tui').write_bytes(header)
            with (self.subTest(machine=machine, elf_type=elf_type),
                  patch.object(update.platform, 'machine', return_value=machine),
                  patch.object(update, 'run', side_effect=['hn 1.2.3', '2.3.4']) as run):
                self.assertEqual(update.versions(self.root), {'hn': '1.2.3', 'cli': '2.3.4'})
                self.assertEqual(run.call_args_list[0].args, (self.root / 'harness-tui', '--version'))

    def test_wrong_or_malformed_binary_is_rejected_before_any_execution(self):
        cases = {'x86-on-arm': elf_fixture(), 'script': b'#!/bin/sh\nprintf "hn 1.2.3\\n"\n',
                 'truncated': elf_fixture(183)[:63]}
        for name, offset, value in [('class32', 4, 1), ('big-endian', 5, 2), ('ident-version', 6, 0),
                                    ('elf-version', 20, 0), ('core-dump', 16, 4)]:
            data = bytearray(elf_fixture(183))
            data[offset] = value
            cases[name] = bytes(data)
        with patch.object(update.platform, 'machine', return_value='aarch64'):
            for name, data in cases.items():
                (self.root / 'harness-tui').write_bytes(data)
                with self.subTest(case=name), patch.object(update, 'run') as run:
                    with self.assertRaisesRegex(ValueError, 'does not match this computer'):
                        update.versions(self.root)
                    run.assert_not_called()

    def record(self, folder, machine):
        folder.mkdir(parents=True)
        for name in update.FILES:
            (folder / name).write_bytes(elf_fixture(machine) if name == 'harness-tui' else b'fixture')
        # Older x86 prepared updates have no architecture field; the actual ELF
        # remains authoritative without invalidating their on-disk record format.
        record = {'versions': {'hn': '1.2.3', 'cli': '2.3.4'}, 'files': {
            name: {'sha256': update.digest(folder / name), 'bytes': (folder / name).stat().st_size}
            for name in update.FILES}}
        update.write(folder / 'release.json', record)
        return record

    def test_existing_x86_prepared_record_still_verifies(self):
        folder = self.root / 'build'
        record = self.record(folder, 62)
        with patch.object(update, 'run', side_effect=['hn 1.2.3', '2.3.4']):
            self.assertEqual(update.verify(folder), record)

    def test_wrong_architecture_with_matching_manifest_cannot_be_activated(self):
        folder = self.root / 'state/builds' / ('a' * 64)
        self.record(folder, 62)
        base = self.root / 'base.json'
        base.write_text('{}\n')
        (folder / 'base.json').write_bytes(base.read_bytes())
        with (patch.object(update.platform, 'machine', return_value='aarch64'),
              patch.object(update, 'STATE', self.root / 'state'), patch.object(update, 'BASE_ID', base),
              patch.object(update, 'SYSTEM_LOCK', self.root / 'lock'),
              patch.object(update, 'RESTART_REQUIRED', self.root / 'restart'),
              patch.object(update, 'prepared', return_value=folder), patch.object(update, 'run') as run,
              patch.object(update, 'select') as select, patch.object(update, 'restart') as restart):
            with self.assertRaisesRegex(ValueError, 'does not match this computer'):
                update.apply()
            run.assert_not_called()
            select.assert_not_called()
            restart.assert_not_called()


class ScreenSelection(unittest.TestCase):
    def test_capture_chooses_os_screen_among_other_clients_and_rejects_bad_ids(self):
        rows = '201\t$1\t@2\t%3\t/dev/pts/8\n202\t$4\t@5\t%6\t/dev/pts/9'
        def groups(path):
            if path == Path('/proc/201/cgroup'):
                return '0::/user.slice/ssh-session.scope\n'
            return '0::/user.slice/app.slice/hn-screen.service\n'
        with patch.object(update, 'run', return_value=rows), \
                patch.object(update.Path, 'read_text', autospec=True, side_effect=groups):
            self.assertEqual(update.capture_view(), {'session': '$4', 'window': '@5', 'pane': '%6', 'tty': '/dev/pts/9'})
        with patch.object(update, 'run', return_value=rows.replace('$4', '--all')), \
                patch.object(update.Path, 'read_text', autospec=True, side_effect=groups):
            self.assertIsNone(update.capture_view())

    def test_restore_targets_reconnected_os_client_and_existing_objects(self):
        view = {'session': '$4', 'window': '@5', 'pane': '%6', 'tty': '/dev/pts/9'}
        commands = []
        def run(*args, **kwargs):
            commands.append(args)
            return {'list-sessions': '$0\n$4', 'list-windows': '@5', 'list-panes': '%6'}.get(args[1], '')
        with patch.object(update, 'run', side_effect=run), \
                patch.object(update, 'capture_view', return_value=dict(view, tty='/dev/pts/20')):
            update.restore_view(view)
        self.assertIn(('/usr/bin/hn', 'switch-client', '-c', '/dev/pts/20', '-t', '$4'), commands)
        self.assertIn(('/usr/bin/hn', 'select-window', '-t', '@5'), commands)
        self.assertIn(('/usr/bin/hn', 'select-pane', '-t', '%6'), commands)
        with patch.object(update, 'run', return_value='$0') as run:
            update.restore_view(view)
        run.assert_called_once_with('/usr/bin/hn', 'list-sessions', '-F', '#{session_id}')
        with patch.object(update, 'run') as run, self.assertRaises(ValueError):
            update.restore_view(dict(view, pane='--all'))
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
