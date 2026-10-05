"""Calibrate live and exited-child CPU against independent getrusage counters."""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest


CHILD = """
import resource, sys, time
end = time.monotonic() + 1.2
while time.monotonic() < end:
    pass
"""
WORKER = r"""
import json, os, resource, subprocess, sys, time
sys.stdin.readline()
before = resource.getrusage(resource.RUSAGE_SELF)
children_before = resource.getrusage(resource.RUSAGE_CHILDREN)
if sys.argv[1] == 'descendants':
    # One live child persists across a sample. Other children live for less
    # than one sampling interval and must still count after being reaped.
    for index in range(3):
        subprocess.run([sys.executable, '-c', sys.argv[2].replace('1.2', '1.2' if index == 0 else '0.35')], check=True)
elif sys.argv[1] == 'unreaped':
    child = subprocess.Popen([sys.executable, '-c', sys.argv[2]])
    # Retain a zombie across two samples. Its CPU has not been transferred to
    # the parent's child counters yet, but must never disappear from the sum.
    time.sleep(3.3)
    child.wait()
else:
    time.sleep(2)
after = resource.getrusage(resource.RUSAGE_SELF)
children_after = resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({'cpuSeconds':
    after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime +
    children_after.ru_utime + children_after.ru_stime - children_before.ru_utime - children_before.ru_stime
}), flush=True)
sys.stdin.read()
"""


@unittest.skipUnless(sys.platform == 'darwin', 'macOS accounting APIs')
class ForestUsageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='harness-forest-calibration-')
        cls.root = Path(cls.temp.name)
        cls.sampler = cls.root / 'sampler'
        subprocess.run(['xcrun', 'swiftc', str(Path(__file__).with_name('process_forest_usage.swift')),
                        '-o', str(cls.sampler)], check=True, capture_output=True, timeout=60)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def measure(self, mode):
        output = self.root / (mode + '.json')
        worker = subprocess.Popen([sys.executable, '-u', '-c', WORKER, mode, CHILD],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True)
        sampler = subprocess.Popen([str(self.sampler), str(worker.pid), '5', mode, str(output)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(select.select([sampler.stderr], [], [], 5)[0])
            self.assertTrue(sampler.stderr.readline().startswith('Sampling owned forest '))
            worker.stdin.write('start\n'); worker.stdin.flush()
            _, error = sampler.communicate(timeout=12)
            self.assertEqual(sampler.returncode, 0, error)
            stdout, error = worker.communicate(timeout=5)
            self.assertEqual(worker.returncode, 0, error)
            independent = json.loads(stdout)
            measured = json.loads(output.read_text())
            print(json.dumps({'mode': mode, 'independent': independent,
                              'measured': measured['summary'], 'clock': measured['cpuClock']}), flush=True)
            return independent, measured
        finally:
            for process in [sampler, worker]:
                if process.poll() is None:
                    process.kill(); process.communicate(timeout=5)

    def test_live_and_reaped_children_match_independent_cpu(self):
        independent, measured = self.measure('descendants')
        actual = independent['cpuSeconds']
        self.assertGreater(actual, 0.5)
        self.assertAlmostEqual(measured['summary']['cpuSeconds'], actual,
                               delta=max(0.06, actual * 0.1))
        self.assertGreater(measured['summary']['processCountMax'], 1)
        self.assertEqual(measured['summary']['processCountMin'], 1)
        # Exercise the new API on real processes without claiming that parent
        # instruction/energy counters contain the exited children's work.
        for sample in measured['samples']:
            for row in sample['processes']:
                self.assertIn(row['rusageFlavor'], [4, 6])
                if row['rusageFlavor'] == 6:
                    self.assertLessEqual(row['performanceUserTicks'], row['userTicks'])
                    self.assertLessEqual(row['performanceSystemTicks'], row['systemTicks'])
                    self.assertLessEqual(row['performanceInstructions'], row['instructions'])
                    self.assertLessEqual(row['performanceCycles'], row['cycles'])
                    self.assertLessEqual(row['performanceCpuEnergyNanojoules'], row['cpuEnergyNanojoules'])
                else:
                    self.assertNotIn('cpuEnergyNanojoules', row)
                    self.assertNotIn('performanceUserTicks', row)

    def test_idle_tree_is_quiet(self):
        independent, measured = self.measure('idle')
        self.assertLess(independent['cpuSeconds'], 0.05)
        self.assertLess(measured['summary']['cpuSeconds'], 0.2)

    def test_unreaped_child_keeps_its_cpu_until_parent_collects_it(self):
        independent, measured = self.measure('unreaped')
        actual = independent['cpuSeconds']
        self.assertGreater(actual, 0.5)
        self.assertAlmostEqual(measured['summary']['cpuSeconds'], actual,
                               delta=max(0.06, actual * 0.1))
        zombies = [row for sample in measured['samples'] for row in sample['processes']
                   if row['exitTicks'] != 0]
        self.assertTrue(zombies, 'Calibration must include the unreaped interval')
        self.assertTrue(all(row['footprintBytes'] == 0 for row in zombies))

    def test_overlapping_roots_are_rejected(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])
        try:
            result = subprocess.run([str(self.sampler), f'{os.getpid()},{child.pid}', '5',
                                     'overlap', str(self.root / 'overlap.json')],
                                    capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('overlap', result.stderr)
        finally:
            child.terminate(); child.wait(timeout=5)

    def test_existing_evidence_is_preserved(self):
        output = self.root / 'existing.json'
        output.write_text('original evidence')
        result = subprocess.run([str(self.sampler), str(os.getpid()), '5', 'existing', str(output)],
                                capture_output=True, text=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output.read_text(), 'original evidence')


if __name__ == '__main__':
    unittest.main()
