"""Portable observer contracts; no VM, worker unit or graphical acceptance."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import update_intent_guest as guest
import update_intent_observer as observer
from update_intent_vm import ROOT, UPDATER, observed_source, ui_owner
from session_vm import PROBE


class ObserverContracts(unittest.TestCase):
    def identity(self):
        token = 'a' * 32
        event = dict(pid=101, start='123', token=token, backend_pane='%999')
        ui = dict(pid=101, start='123', token=token, group='101', foreground='101',
                  stdin='/dev/pts/7', argv=['/usr/bin/python3', UPDATER, 'screen'])
        state = dict(boot='boot', uis=[ui], ownership=dict(socket='/tmp/hn-1000/default@456.sock', active='%4',
            registrations=[dict(pid=101, start='123', token=token, boot_id='boot')],
            panes=[dict(pane='%4', window='@2', dead='0', token=token)]))
        return state, event

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
            lambda s: s['ownership']['panes'].append(dict(s['ownership']['panes'][0], pane='%5')),
            lambda s: s['ownership'].update(active='%5'),
        ]
        for index, change in enumerate(changes):
            with self.subTest(case=index):
                state, event = self.identity()
                change(state)
                with self.assertRaises(AssertionError):
                    ui_owner(state, event)

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
            self.assertEqual(records[-1]['token'], request['target'])
            self.assertLessEqual(json.loads(first_poll)['at'], records[-1]['at'])

    def test_generated_guest_sources_compile_without_execution(self):
        source = (ROOT / 'os/live_update.py').read_text()
        compile(observed_source(source), 'private-observed-live-update.py', 'exec')
        compile(PROBE, 'private-terminal-probe.py', 'exec')
        with self.assertRaisesRegex(ValueError, 'entrypoint'):
            observed_source(source.replace("if __name__ == '__main__':", ''))


if __name__ == '__main__':
    unittest.main()
