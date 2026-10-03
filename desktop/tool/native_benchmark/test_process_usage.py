"""Calibrate the macOS sampler against an independent getrusage CPU counter.

Runs only private Python workers; no app, agent, or existing process is controlled.
Run: python3 tool/native_benchmark/test_process_usage.py
"""
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest


SAMPLER_SOURCE = Path(__file__).with_name("process_usage.swift")
WORKER = r"""
import json, resource, sys, time
sys.stdin.readline()  # Start only after the sampler has its first counter.
before = resource.getrusage(resource.RUSAGE_SELF)
start = time.monotonic()
if sys.argv[1] == 'busy':
    while time.monotonic() - start < 3:
        pass
else:
    time.sleep(3)
after = resource.getrusage(resource.RUSAGE_SELF)
print(json.dumps({
    'cpuSeconds': after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime,
    'workWallSeconds': time.monotonic() - start,
}), flush=True)
sys.stdin.read()  # Stay alive until the sampler finishes.
"""


@unittest.skipUnless(sys.platform == "darwin", "proc_pid_rusage is macOS-only")
class ProcessUsageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="harness-resource-calibration-")
        cls.root = Path(cls.temp.name)
        cls.sampler = cls.root / "process-usage"
        subprocess.run(
            ["xcrun", "swiftc", str(SAMPLER_SOURCE), "-o", str(cls.sampler)],
            check=True, capture_output=True, text=True, timeout=60,
        )

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def measure(self, mode):
        output = self.root / f"{mode}.json"
        worker = subprocess.Popen(
            [sys.executable, "-u", "-c", WORKER, mode],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        sampler = subprocess.Popen(
            [str(self.sampler), str(worker.pid), "5", mode, str(output)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.wait_for_start(sampler)
            worker.stdin.write("start\n")
            worker.stdin.flush()
            _, sampler_error = sampler.communicate(timeout=12)
            self.assertEqual(sampler.returncode, 0, sampler_error)
            stdout, stderr = worker.communicate(timeout=5)
            self.assertEqual(worker.returncode, 0, stderr)
            independent = json.loads(stdout)
            measured = json.loads(output.read_text())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            print(json.dumps({"mode": mode, "independent": independent,
                              "measured": measured["summary"],
                              "cpuClock": measured.get("cpuClock")}), flush=True)
            return independent, measured
        finally:
            if sampler.poll() is None:
                sampler.kill()
                sampler.communicate(timeout=5)
            if worker.poll() is None:
                worker.kill()
                worker.communicate(timeout=5)

    def wait_for_start(self, sampler):
        readable, _, _ = select.select([sampler.stderr], [], [], 5)
        self.assertTrue(readable, "Sampler did not confirm its first counter")
        self.assertTrue(sampler.stderr.readline().startswith("Sampling process "))

    def test_busy_cpu_matches_getrusage(self):
        independent, measured = self.measure("busy")
        actual = independent["cpuSeconds"]
        self.assertGreater(actual, 0.5, "Host must permit a useful calibration workload")
        # Allow worker startup and small differences at the sampling boundary.
        # This compares independent kernel APIs, not the sampler's own conversion.
        self.assertAlmostEqual(measured["summary"]["cpuSeconds"], actual,
                               delta=max(0.05, actual * 0.1))
        self.assertEqual(measured["schema"], 2)
        self.assertEqual(measured["cpuClock"]["unit"], "mach_absolute_time")
        self.assertGreater(measured["cpuClock"]["timebaseDenom"], 0)
        self.assertTrue(all(sample["processStartMachTicks"] ==
                            measured["samples"][0]["processStartMachTicks"]
                            for sample in measured["samples"]))
        self.assertNotIn("userNanoseconds", measured["samples"][0])

    def test_sleeping_worker_has_little_cpu(self):
        independent, measured = self.measure("idle")
        self.assertLess(independent["cpuSeconds"], 0.05)
        self.assertLess(measured["summary"]["cpuSeconds"], 0.2)

    def test_existing_output_is_preserved(self):
        output = self.root / "preserved.json"
        output.write_text("existing evidence\n")
        result = subprocess.run(
            [str(self.sampler), str(os.getpid()), "5", "existing", str(output)],
            capture_output=True, text=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Output already exists", result.stderr)
        self.assertEqual(output.read_text(), "existing evidence\n")

    def test_output_created_during_sampling_is_preserved(self):
        output = self.root / "concurrent.json"
        sampler = subprocess.Popen(
            [str(self.sampler), str(os.getpid()), "5", "concurrent", str(output)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            self.wait_for_start(sampler)
            output.write_text("other sample's evidence\n")
            _, stderr = sampler.communicate(timeout=8)
            self.assertNotEqual(sampler.returncode, 0)
            self.assertIn("existing evidence is preserved", stderr)
            self.assertEqual(output.read_text(), "other sample's evidence\n")
        finally:
            if sampler.poll() is None:
                sampler.kill()
                sampler.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
