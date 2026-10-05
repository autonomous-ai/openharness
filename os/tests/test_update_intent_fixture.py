"""Portable observer contracts; no VM, worker unit or graphical acceptance."""
import ast
import copy
from concurrent.futures import ThreadPoolExecutor
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import tarfile
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import update_intent_guest as guest
import update_intent_observer as observer
from update_intent_vm import ROOT, UPDATER, observed_source, pane_windows, renderer_replaced, ui_owner
from session_vm import PROBE


class ObserverContracts(unittest.TestCase):
    def x86_trace(self):
        tree = ast.parse((ROOT / 'os/tests/update_pane_vm.py').read_text())
        traces = [node.value.value for node in ast.walk(tree) if isinstance(node, ast.Assign)
                  and any(isinstance(target, ast.Name) and target.id == 'trace' for target in node.targets)
                  and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)]
        self.assertEqual(len(traces), 1)
        return traces[0]

    def test_serial_and_direct_formats_keep_exact_unique_pane_window_pairs(self):
        self.assertEqual(pane_windows('%0|@0\n%3|@1\n', '|'),
                         pane_windows('%0\t@0\n%3\t@1\n', '\t'))
        for raw in ['', '%0@0\n', '%0|@0|extra\n', '%0|window\n',
                    'pane|@0\n', '%0|@0\n%0|@1\n']:
            with self.subTest(raw=raw), self.assertRaises(AssertionError):
                pane_windows(raw, '|')

    def test_archive_keeps_evidence_bytes_without_assets_or_symlink_dereference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            folder = root / 'fixture'
            folder.mkdir()
            (folder / 'assets').mkdir()
            (folder / 'assets/payload').write_bytes(b'not evidence')
            evidence = b'raw\tbytes\0\xff\n'
            (folder / 'events.jsonl').write_bytes(evidence)
            (folder / 'payload-link').symlink_to('assets/payload')
            saved = root / 'evidence.tar'
            with patch.object(guest, 'FIXTURE', folder):
                guest.archive(saved)
            with tarfile.open(saved) as archive:
                self.assertEqual(archive.getnames(), ['events.jsonl', 'payload-link'])
                self.assertEqual(archive.extractfile('events.jsonl').read(), evidence)
                self.assertTrue(archive.getmember('payload-link').issym())
                self.assertEqual(archive.getmember('payload-link').linkname, 'assets/payload')
            self.assertEqual((folder / 'events.jsonl').read_bytes(), evidence)
            self.assertEqual((folder / 'assets/payload').read_bytes(), b'not evidence')

    def identity(self):
        token = 'a' * 32
        event = dict(pid=101, start='123', token=token, backend_pane='%999')
        ui = dict(pid=101, start='123', token=token, group='101', foreground='101',
                  stdin='/dev/pts/7', argv=['/usr/bin/python3', UPDATER, 'screen'])
        state = dict(boot='boot', uis=[ui], ownership=dict(socket='/tmp/hn-1000/default@456.sock', active='%4',
            registrations=[dict(pid=101, start='123', token=token, boot_id='boot')],
            panes=[dict(pane='%4', window='@2', dead='0', token=token,
                        launch='"exec env HARNESS_UPDATE_INSTANCE=' + token + ' /usr/bin/python3 ' + UPDATER + ' screen"')]))
        return state, event

    def test_observers_require_the_exact_quoted_launch_without_shell_parsing(self):
        import update_pane_guest as x86_guest
        state, event = self.identity()
        launch = state['ownership']['panes'][0]['launch']
        for parser in [guest.launch_token, x86_guest.launch_token]:
            self.assertEqual(parser(launch), event['token'])
            for invalid in [launch[1:-1], launch.replace('exec env ', 'env '),
                            launch.replace(event['token'], event['token'].upper()),
                            launch.replace(' /usr/bin/python3', ' python3'),
                            launch.replace(' screen', ' check'), launch[:-1] + '; true"',
                            launch + ' ', launch.replace(' screen', ' screen\\n')]:
                with self.subTest(parser=parser.__module__, invalid=invalid):
                    self.assertIsNone(parser(invalid))

    def test_token_correlates_distinct_backend_and_public_panes(self):
        state, event = self.identity()
        owner = ui_owner(state, event)
        self.assertEqual((owner['pane'], owner['backend_pane']), ('%4', '%999'))
        self.assertEqual(owner['socket'], state['ownership']['socket'])

    def test_stale_ambiguous_background_and_unselected_owners_are_rejected(self):
        changes = [
            lambda s: s['uis'][0].update(start='reused'),
            lambda s: s['uis'][0].update(token='b' * 32),
            lambda s: s['uis'][0].update(foreground='other'),
            lambda s: s['uis'][0].update(argv=['/usr/bin/python3', UPDATER, 'check']),
            lambda s: s['ownership']['registrations'][0].update(boot_id='earlier'),
            lambda s: s['ownership']['registrations'].clear(),
            lambda s: s['ownership']['registrations'].append(copy.deepcopy(s['ownership']['registrations'][0])),
            lambda s: s['ownership']['panes'][0].update(dead='1'),
            lambda s: s['ownership']['panes'][0].update(launch='different command'),
            lambda s: s['ownership']['panes'].append(dict(s['ownership']['panes'][0], pane='%5')),
            lambda s: s['ownership'].update(active='%5'),
        ]
        for index, change in enumerate(changes):
            with self.subTest(case=index):
                state, event = self.identity()
                change(state)
                with self.assertRaises(AssertionError):
                    ui_owner(state, event)

    def test_renderer_replacement_requires_actual_new_identity_and_selected_executable(self):
        before = dict(selected='/usr/lib/harness', clients=[dict(session='$0', process=dict(
            pid=10, start='100', executable='/usr/lib/harness/harness-tui'))])
        after = dict(selected='/home/me/.local/state/harness-os/updates/builds/new',
                     clients=[dict(session='$0', process=dict(pid=11, start='200',
                         executable='/home/me/.local/state/harness-os/updates/builds/new/harness-tui'))])
        self.assertEqual(renderer_replaced(before, after)['after']['pid'], 11)
        for change in [lambda s: s['clients'][0]['process'].update(pid=10, start='100'),
                       lambda s: s['clients'][0]['process'].update(executable='/usr/lib/harness/harness-tui'),
                       lambda s: s['clients'][0].update(session='$1'),
                       lambda s: s['clients'].append(copy.deepcopy(s['clients'][0]))]:
            with self.subTest(change=change):
                value = copy.deepcopy(after)
                change(value)
                with self.assertRaises(AssertionError):
                    renderer_replaced(before, value)

    def test_x86_renderer_restart_requires_new_process_with_the_same_frozen_binary(self):
        from update_pane_vm import renderer_replaced as x86_renderer_replaced
        before = dict(pid=10, start='100', executable='/usr/lib/harness/harness-tui',
                      executable_sha256='a' * 64, session='$0')
        after = dict(before, pid=11, start='200')
        self.assertEqual(x86_renderer_replaced(before, after, 'a' * 64)['after'], after)
        for fields in [dict(pid=10), dict(start='100'), dict(executable='/tmp/other'),
                       dict(executable_sha256='b' * 64), dict(session='$1')]:
            with self.subTest(fields=fields), self.assertRaises(AssertionError):
                x86_renderer_replaced(before, dict(after, **fields), 'a' * 64)

    def test_merged_event_order_ignores_pid_sort_and_partial_append(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(guest, 'FIXTURE', Path(temporary)):
            earlier = dict(at=1.0, pid=999, start='1', event='screen-enter')
            later = dict(at=2.0, pid=1000, start='2', event='screen-enter')
            (guest.FIXTURE / 'events-999.jsonl').write_text(json.dumps(earlier) + '\n')
            (guest.FIXTURE / 'events-1000.jsonl').write_text(json.dumps(later) + '\n{"incomplete":')
            self.assertEqual(guest.events(), [earlier, later])

    def test_oneshot_activating_and_failed_states_are_not_success(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(guest, 'FIXTURE', Path(temporary)):
            for state, result, status, expected in [('activating', 'success', '0', False),
                                                   ('inactive', 'exit-code', '1', False),
                                                   ('inactive', 'success', '0', True)]:
                raw = f'ActiveState={state}\nSubState=dead\nResult={result}\nExecMainStatus={status}\nMainPID=0\nExecMainCode=1\n'
                with self.subTest(state=state, result=result), patch.object(guest.subprocess, 'check_output', return_value=raw):
                    self.assertIs(guest.checker_complete('test'), expected)
                    self.assertEqual(json.loads((guest.FIXTURE / 'test-checker.json').read_text())['raw'], raw)

    def test_observer_preserves_actual_target_rejection_and_atomic_claim_results(self):
        spec = importlib.util.spec_from_file_location('intent_observer_product', ROOT / 'os/live_update.py')
        product = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(product)
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=True):
            root = Path(temporary)
            product.STATE, product.PROC = root / 'state', root / 'proc'
            product.STATE.mkdir()
            proc = product.PROC / str(os.getpid())
            proc.mkdir(parents=True)
            (proc / 'stat').write_text('1 (python) ' + ' '.join(['S'] + ['0'] * 18 + ['123']))
            fixture = root / 'fixture'
            fixture.mkdir()
            (fixture / 'gate.json').write_text('{"token":"shortcut"}')
            observer.install(product.__dict__, fixture)
            request = dict(requested_at=1, target='a' * 32)
            product.write(product.STATE / 'request.json', request)
            self.assertIs(product.consume_request(), False)
            self.assertEqual(product.read(product.STATE / 'request.json'), request)
            first_poll = (fixture / 'direct-poll.json').read_bytes()
            self.assertIs(product.consume_request(), False)
            self.assertEqual((fixture / 'direct-poll.json').read_bytes(), first_poll)
            with patch.dict(os.environ, {'HARNESS_UPDATE_INSTANCE': 'a' * 32}):
                self.assertIs(product.consume_request(), True)
            self.assertFalse((product.STATE / 'request.json').exists())
            with patch.object(guest, 'FIXTURE', fixture):
                records = guest.events()
            self.assertEqual([item['event'] for item in records], ['request-published', 'request-rejected', 'request-rejected', 'request-claimed'])
            self.assertEqual(records[0]['request'], request)
            self.assertIs(records[1]['result'], False)
            self.assertIsNone(records[1]['token'])
            self.assertIs(records[-1]['result'], True)
            self.assertEqual(records[-1]['locked_reads'], [request])
            self.assertEqual(records[-1]['token'], request['target'])
            self.assertLessEqual(json.loads(first_poll)['at'], records[-1]['at'])

    def test_actual_claim_records_publication_after_unlocked_sample_while_waiting_for_lock(self):
        spec = importlib.util.spec_from_file_location('intent_claim_product', ROOT / 'os/live_update.py')
        product = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(product)
        token = 'a' * 32
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {'HARNESS_UPDATE_INSTANCE': token}, clear=True):
            root = Path(temporary)
            product.STATE, product.PROC = root / 'state', root / 'proc'
            product.STATE.mkdir()
            proc = product.PROC / str(os.getpid())
            proc.mkdir(parents=True)
            (proc / 'stat').write_text('1 (python) ' + ' '.join(['S'] + ['0'] * 18 + ['123']))
            fixture = root / 'fixture'
            fixture.mkdir()
            (fixture / 'gate.json').write_text('{"token":"reuse"}')
            observer.install(product.__dict__, fixture)
            real_flock = fcntl.flock
            attempted = threading.Event()
            def acquire(fd, operation):
                if operation == fcntl.LOCK_EX:
                    attempted.set()
                return real_flock(fd, operation)
            request = dict(requested_at=1, target=token)
            with ThreadPoolExecutor(max_workers=1) as pool, (product.STATE / 'open.lock').open('a') as lock:
                real_flock(lock, fcntl.LOCK_EX)
                with patch.object(product.fcntl, 'flock', side_effect=acquire):
                    future = pool.submit(product.consume_request)
                    try:
                        self.assertTrue(attempted.wait(2), 'Actual consume did not reach the held lock')
                        self.assertFalse(future.done())
                        product.write(product.STATE / 'request.json', request)
                    finally:
                        real_flock(lock, fcntl.LOCK_UN)
                    self.assertIs(future.result(timeout=2), True)
            with patch.object(guest, 'FIXTURE', fixture):
                records = guest.events()
            publication, claim = records
            self.assertEqual(publication['event'], 'request-published')
            self.assertEqual(claim['event'], 'request-claimed')
            self.assertIsNone(claim['before'])
            self.assertEqual(claim['locked_reads'], [publication['request']])
            self.assertEqual(claim['token'], token)
            self.assertIs(claim['result'], True)
            self.assertIsNone(claim['after'])
            self.assertFalse((product.STATE / 'request.json').exists())

    def test_x86_owner_acknowledges_before_publication_after_an_inflight_empty_poll(self):
        token = 'a' * 32
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            state = folder / 'state'
            state.mkdir()
            proc = folder / 'proc' / str(os.getpid())
            proc.mkdir(parents=True)
            (proc / 'stat').write_text('1 (python) ' + ' '.join(['S'] + ['0'] * 18 + ['123']))
            def path(value):
                original = Path(value)
                return folder / original.name if str(original).startswith('/tmp/update-pane-') else original
            modules = []
            for name, environment in [('owner', {'HARNESS_UPDATE_INSTANCE': token}), ('direct', {})]:
                spec = importlib.util.spec_from_file_location('x86_route_' + name, ROOT / 'os/live_update.py')
                product = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(product)
                product.STATE, product.PROC, product.Path = state, proc.parent, path
                # Separate guest processes have independent environments and
                # observer globals; retain real file/lock operations here.
                product.os = SimpleNamespace(environ=environment, getpid=os.getpid, open=os.open,
                                             close=os.close, fsync=os.fsync, O_RDONLY=os.O_RDONLY)
                exec(compile(self.x86_trace(), 'private-x86-ownership-hook.py', 'exec'), product.__dict__)
                modules.append(product)
            owner, direct = modules
            gate = path('/tmp/update-pane-route-gate')
            armed = path('/tmp/update-pane-route-armed.json')
            rejected = path('/tmp/update-pane-route-rejected.json')
            claimed = path('/tmp/update-pane-route-claimed.json')
            real_flock, attempted, acknowledged = fcntl.flock, threading.Event(), threading.Event()
            def acquire(fd, operation):
                if operation == fcntl.LOCK_EX:
                    attempted.set()
                return real_flock(fd, operation)
            original_write = owner.write
            def write(destination, value):
                result = original_write(destination, value)
                if destination == armed:
                    acknowledged.set()
                return result
            owner.write = write
            with ThreadPoolExecutor(max_workers=1) as pool:
                # Drain an already-entered empty consume before the host can
                # observe the next poll's gate acknowledgement and send a key.
                with (state / 'open.lock').open('a') as lock:
                    real_flock(lock, fcntl.LOCK_EX)
                    with patch.object(owner.fcntl, 'flock', side_effect=acquire):
                        empty = pool.submit(owner.consume_request)
                        try:
                            self.assertTrue(attempted.wait(2))
                            self.assertFalse(empty.done())
                            gate.write_text(token)
                        finally:
                            real_flock(lock, fcntl.LOCK_UN)
                        self.assertIs(empty.result(timeout=2), False)
                self.assertFalse(armed.exists())
                waiting = pool.submit(owner.consume_request)
                self.assertTrue(acknowledged.wait(2))
                self.assertFalse(waiting.done())
                self.assertFalse((state / 'request.json').exists())
                self.assertIs(direct.consume_request(), False)
                self.assertFalse(rejected.exists())
                request = dict(requested_at=1, target=token)
                with (state / 'open.lock').open('a') as lock:
                    real_flock(lock, fcntl.LOCK_EX)
                    owner.write(state / 'request.json', request)
                    real_flock(lock, fcntl.LOCK_UN)
                self.assertIs(direct.consume_request(), False)
                self.assertIs(waiting.result(timeout=2), True)
            records = [json.loads(p.read_text()) for p in [armed, rejected, claimed]]
            self.assertEqual(records[0]['token'], token)
            self.assertIs(records[1]['claimed'], False)
            self.assertIsNone(records[1]['token'])
            self.assertIs(records[2]['claimed'], True)
            self.assertEqual(records[2]['token'], token)
            self.assertEqual(records[1]['locked_reads'], [request])
            self.assertEqual(records[2]['locked_reads'], [request])
            self.assertEqual(records[2]['before'], {})
            self.assertEqual(records[2]['after'], {})
            self.assertLessEqual(records[0]['at'], records[1]['at'])
            self.assertLessEqual(records[1]['at'], records[2]['at'])
            self.assertFalse((state / 'request.json').exists())

    def test_generated_guest_sources_compile_without_execution(self):
        source = (ROOT / 'os/live_update.py').read_text()
        compile(observed_source(source), 'private-observed-live-update.py', 'exec')
        compile(PROBE, 'private-terminal-probe.py', 'exec')
        compile(self.x86_trace(), 'private-x86-ownership-hook.py', 'exec')
        with self.assertRaisesRegex(ValueError, 'entrypoint'):
            observed_source(source.replace("if __name__ == '__main__':", ''))


if __name__ == '__main__':
    unittest.main()
