"""GPU health failures must be visible and cannot masquerade as acceptance."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('gpu_health', Path(__file__).parents[1] / 'gpu_health.py')
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


def card(address='0000:01:00.0', driver='nvidia', override=None):
    return dict(address=address, id='10de:2684', driver=driver, driver_override=override, **{'class': '030000'})


def inventory(cards=None):
    return dict(schema=1, boot_id='first', kernel='fixture', driver_version='615.71.09',
                cards=[card()] if cards is None else cards, libraries={})


def result(kind, address, timeout):
    names = ['cuda.device', 'cuda.memory', 'cuda.compute'] if kind == 'cuda' else ['graphics.render']
    return dict(probe=kind, address=address, status='passed', checks=[dict(test=name, status='passed') for name in names])


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in [('STATE', self.root / 'state'), ('SYSTEM_STATE', self.root / 'system')]:
            value.mkdir()
            patcher = patch.object(health, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.connected = patch.object(health, 'connections', return_value={'card0-DP-1': 'connected'})
        self.connected.start()
        self.addCleanup(self.connected.stop)

    def test_no_gpu_and_passthrough_never_load_cuda_or_notify(self):
        for cards in [[], [card(driver='vfio-pci')], [card(driver=None, override='vfio-pci')],
                      [card(driver=None, override='pci-stub')]]:
            with self.subTest(cards=cards), patch.object(health, 'inventory', return_value=inventory(cards)), \
                    patch.object(health, 'probe', side_effect=AssertionError('GPU was touched')):
                report = health.check(force=True)
                self.assertEqual(report['status'], 'skipped')
                with patch.object(health.subprocess, 'run') as run:
                    self.assertFalse(health.notify(report))
                    run.assert_not_called()

    def test_every_gpu_is_checked_and_one_bad_card_fails_the_report(self):
        second = '0000:02:00.0'
        def broken(kind, address, timeout):
            item = result(kind, address, timeout)
            if address == second and kind == 'cuda':
                item['status'] = 'failed'
                item['checks'][-1] = dict(test='cuda.compute', status='failed', detail='wrong answer')
            return item
        with patch.object(health, 'probe', side_effect=broken) as probe:
            report = health.evaluate(inventory([card(), card(second)]))
        self.assertEqual(probe.call_count, 4)
        self.assertEqual([row['status'] for row in report['devices']], ['passed', 'failed'])
        self.assertEqual(report['status'], 'failed')
        self.assertEqual(report['devices'][1]['checks'][3]['detail'], 'wrong answer')

    def test_headless_graphics_unavailable_is_explicitly_partial_not_broken_compute(self):
        def headless(kind, address, timeout):
            if kind == 'graphics':
                return dict(status='failed', checks=[dict(test='graphics.device', status='failed', operation='graphics.device', detail='No EGL device')])
            return result(kind, address, timeout)
        with patch.object(health, 'connections', return_value={}), patch.object(health, 'probe', side_effect=headless):
            report = health.evaluate(inventory())
        self.assertEqual(report['status'], 'partial')
        self.assertEqual(report['devices'][0]['checks'][-1]['status'], 'not-tested')

    def test_bad_graphics_readback_fails_even_without_a_monitor(self):
        def bad_color(kind, address, timeout):
            if kind == 'graphics':
                return dict(status='failed', checks=[dict(test='graphics.render', status='failed', operation='graphics.readback', detail='Wrong pixel')])
            return result(kind, address, timeout)
        with patch.object(health, 'connections', return_value={}), patch.object(health, 'probe', side_effect=bad_color):
            self.assertEqual(health.evaluate(inventory())['status'], 'failed')

    def test_missing_managed_driver_is_failure_but_existing_unsupported_gpu_is_not_claimed(self):
        current = inventory([card(driver='nouveau')])
        with patch.object(health, 'probe') as probe:
            self.assertEqual(health.evaluate(current)['status'], 'partial')
            (health.SYSTEM_STATE / 'hardware.json').write_text(json.dumps({'nvidia': {'status': 'installed', 'devices': ['10de:2684']}}))
            report = health.evaluate(current)
            self.assertEqual(report['status'], 'failed')
            self.assertEqual(report['devices'][0]['checks'][0]['test'], 'driver.binding')
            probe.assert_not_called()

    def test_cache_survives_screen_restart_but_boot_driver_device_or_test_change_rechecks(self):
        current = inventory()
        with patch.object(health, 'inventory', side_effect=lambda: copy.deepcopy(current)), patch.object(health, 'probe', side_effect=result) as probe:
            original = health.check()
            self.assertEqual(health.check(), original)
            self.assertEqual(probe.call_count, 2)
            for field, value in [('boot_id', 'second'), ('driver_version', '616.0'), ('kernel', 'next'), ('cards', [card('0000:03:00.0')]), ('schema', 2)]:
                current[field] = value
                health.check()
            self.assertEqual(probe.call_count, 12)
            self.assertFalse(health.cached_report()['stale'])
            current['driver_version'] = 'new'
            self.assertTrue(health.cached_report()['stale'])

    def test_last_working_result_is_retained_after_failure(self):
        with patch.object(health, 'inventory', return_value=inventory()), patch.object(health, 'probe', side_effect=result):
            health.check()
        good = (health.STATE / 'last-working.json').read_bytes()
        with patch.object(health, 'inventory', return_value=inventory()), patch.object(health, 'probe', return_value={
            'status': 'failed', 'checks': [dict(test='cuda', status='failed', detail='driver mismatch')]}):
            self.assertEqual(health.check(force=True)['status'], 'failed')
        self.assertEqual((health.STATE / 'last-working.json').read_bytes(), good)

    def test_running_update_defers_without_replacing_good_evidence_or_claiming_failure(self):
        original_exists = Path.exists
        def exists(path):
            return str(path) == '/run/harness-os-restart-required' or original_exists(path)
        with patch.object(health, 'inventory', return_value=inventory()), patch.object(Path, 'exists', exists), patch.object(health, 'probe') as probe:
            report = health.check()
            self.assertEqual(report['status'], 'deferred')
            self.assertNotIn('fingerprint', report)
            probe.assert_not_called()

    def test_changed_driver_during_check_cannot_be_recorded_as_working(self):
        with patch.object(health, 'inventory', side_effect=[inventory(), dict(inventory(), driver_version='new')]), patch.object(health, 'probe', side_effect=result):
            report = health.check()
        self.assertEqual(report['status'], 'deferred')
        self.assertFalse((health.STATE / 'last-working.json').exists())

    def test_timeout_crash_incomplete_or_wrong_device_result_never_passes(self):
        cases = [subprocess.TimeoutExpired(['probe'], 20, output=b'{"stage":"cuda.compute"}\n{"operation":"cuCtxSynchronize"}\n'),
                 subprocess.CompletedProcess([], -11, '{"stage":"cuda.device"}', 'crash'),
                 subprocess.CompletedProcess([], 0, json.dumps({'result': dict(result('cuda', '0000:01:00.0', 1), checks=[])}), ''),
                 subprocess.CompletedProcess([], 0, json.dumps({'result': result('cuda', '0000:02:00.0', 1)}), '')]
        for case in cases:
            with self.subTest(case=case), patch.object(health.subprocess, 'run', side_effect=case if isinstance(case, Exception) else None,
                                                     return_value=case):
                report = health.probe('cuda', '0000:01:00.0', 20)
                self.assertEqual(report['status'], 'failed')
                if isinstance(case, Exception):
                    self.assertEqual(report['checks'][0]['operation'], 'cuCtxSynchronize')

    def test_probe_ignores_agent_gpu_filters_and_has_finite_timeout(self):
        with patch.dict(health.os.environ, CUDA_VISIBLE_DEVICES='1', LD_PRELOAD='/tmp/injected.so'), patch.object(
                health.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps({'result': result('cuda', '0000:01:00.0', 1)}), '')) as run:
            self.assertEqual(health.probe('cuda', '0000:01:00.0', 20)['status'], 'passed')
        self.assertNotIn('CUDA_VISIBLE_DEVICES', run.call_args.kwargs['env'])
        self.assertNotIn('LD_PRELOAD', run.call_args.kwargs['env'])
        self.assertEqual(run.call_args.kwargs['timeout'], 20)


if __name__ == '__main__':
    unittest.main()
