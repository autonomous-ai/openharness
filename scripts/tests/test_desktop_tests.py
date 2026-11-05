import importlib.util
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from desktop_vm_fixture import suite

SCRIPT = Path(__file__).resolve().parents[1] / "test-desktop.py"
spec = importlib.util.spec_from_file_location("test_desktop", SCRIPT)
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class WorkerCountTests(unittest.TestCase):
    def test_large_host_capacity_keeps_small_host_limits_and_an_upper_bound(self):
        for cpus, expected in ((None, 1), (1, 1), (2, 1), (8, 4), (15, 7), (16, 12), (64, 12)):
            with self.subTest(cpus=cpus), mock.patch.object(driver.os, "cpu_count", return_value=cpus):
                self.assertEqual(driver.default_workers(), expected)

    def test_shards_cover_every_file_once_and_reject_invalid_or_empty_assignments(self):
        files = [f"test/{i}_test.dart" for i in range(11)]
        groups = [driver.partition(files, driver.shard_pair(f"{i}/4")) for i in range(1, 5)]
        selected = [path for group in groups for path in group]
        self.assertEqual(set(selected), set(files))
        self.assertEqual(len(selected), len(set(selected)))
        for value in ["0/4", "1/0", "5/4", "1", "-1/4", "1/4/2", "01/4"]:
            with self.subTest(value=value), self.assertRaises(driver.argparse.ArgumentTypeError):
                driver.shard_pair(value)
        with self.assertRaises(ValueError):
            driver.partition(files[:1], (2, 2))


class DurationSplitTests(unittest.TestCase):
    """Task #3458: shard 3 hit its 10-minute limit with tests passing, because round-robin by name ignored file times."""

    def loads(self, groups, durations):
        return [sum(durations[path] for path in group) for group in groups]

    def test_heavy_files_spread_across_shards_and_every_file_runs_once(self):
        durations = {"test/a_test.dart": 100, "test/b_test.dart": 90, "test/c_test.dart": 60, "test/d_test.dart": 50,
                     **{f"test/small{i}_test.dart": 5 for i in range(10)}}
        files = sorted(durations)
        groups = [driver.partition(files, (i, 2), durations) for i in (1, 2)]
        self.assertEqual(sorted(p for g in groups for p in g), files)
        loads = self.loads(groups, durations)
        # Round-robin by name put a, c and four small files together (190 + 20 against 140 + 30).
        self.assertLessEqual(max(loads) - min(loads), 10, loads)
        for group in groups:
            self.assertEqual(group, sorted(group))

    def test_a_file_with_no_measurement_counts_as_the_median(self):
        durations = {"test/a_test.dart": 10, "test/b_test.dart": 20, "test/c_test.dart": 30}
        self.assertEqual(driver.file_weights(["test/a_test.dart", "test/new_test.dart"], durations),
                         {"test/a_test.dart": 10, "test/new_test.dart": 20})

    def test_absolute_paths_use_their_desktop_relative_measurement(self):
        durations = {"test/a_test.dart": 100, "test/b_test.dart": 1, "test/c_test.dart": 1}
        absolute = [f"/work/repo/desktop/test/{n}_test.dart" for n in "abc"]
        self.assertEqual(driver.partition(absolute, (1, 2), durations), [absolute[0]])

    def test_without_measurements_the_split_stays_round_robin(self):
        files = [f"test/{i:02d}_test.dart" for i in range(11)]
        for durations in ({}, None):
            with self.subTest(durations=durations):
                self.assertEqual([driver.partition(files, (i, 4), durations) for i in range(1, 5)],
                                 [files[i - 1::4] for i in range(1, 5)])

    def test_unreadable_durations_file_falls_back_to_equal_weights(self):
        with tempfile.TemporaryDirectory() as folder:
            broken = Path(folder) / "durations.json"
            broken.write_text("{not json")
            self.assertEqual(driver.load_durations(broken), {})
            self.assertEqual(driver.load_durations(Path(folder) / "missing.json"), {})

    @unittest.skipUnless((SCRIPT.parents[1] / "desktop" / "test").is_dir(),
                         "needs the Desktop test files; ci.yml runs it in desktop-tests, whose checkout has them")
    def test_ci_split_leaves_every_shard_a_quarter_of_its_time_limit(self):
        """The committed durations, CI's shard count, workers and limit, and today's test files: each shard's estimate stays
        within 75% of its limit, with a slow runner's margin. Fails before CI does when the suite outgrows its shards."""
        root = SCRIPT.parents[1]
        workflow = (root / ".github" / "workflows" / "ci.yml").read_text()
        command = re.search(r'test-desktop\.py --shard "\$DESKTOP_SHARD/(\d+)" --workers (\d+) --timeout (\d+)', workflow)
        self.assertIsNotNone(command, "ci.yml's Desktop shard command changed shape")
        shards, workers, limit = (int(value) for value in command.groups())
        matrix = re.search(r"desktop-tests:.*?shard: \[([0-9, ]+)\]", workflow, re.S)
        self.assertEqual([int(v) for v in matrix.group(1).split(",")], list(range(1, shards + 1)))
        durations = driver.load_durations()
        self.assertGreater(len(durations), 500, "the durations file is missing or nearly empty")
        inventory = [Path(p).relative_to(root / "desktop").as_posix() for p in driver.select_files(root / "desktop", [])]
        weights = driver.file_weights(inventory, durations)
        for index in range(1, shards + 1):
            group = driver.partition(inventory, (index, shards), durations)
            estimate = driver.SLOW_RUNNER * sum(weights[p] for p in group) / workers + driver.STARTUP_SECONDS
            with self.subTest(shard=index):
                self.assertLessEqual(estimate, 0.75 * limit, f"shard {index}/{shards}: about {estimate:.0f}s of {limit}s")


class CiGuardStepTests(unittest.TestCase):
    """Review of #3241: the guard step must name its test so a rename fails loudly, and the shard verifier must expect as
    many shards as CI runs."""

    def setUp(self):
        self.root = SCRIPT.parents[1]
        self.workflow = (self.root / ".github" / "workflows" / "ci.yml").read_text()

    def test_the_ci_guard_step_names_a_test_that_exists(self):
        step = re.search(r"Every Desktop shard keeps a quarter.*?run: (.+)", self.workflow, re.S)
        self.assertIsNotNone(step, "ci.yml lost the headroom guard step")
        command = step.group(1).splitlines()[0]
        named = re.search(r"python3 -m unittest -v (test_desktop_tests\.DurationSplitTests\.\w+)$", command)
        self.assertIsNotNone(named, f"the guard step runs a filter, not one named test: {command}")
        test = named.group(1).split(".")[-1]
        self.assertTrue(hasattr(DurationSplitTests, test), f"{test} does not exist")

    def test_the_shard_verifier_expects_as_many_shards_as_ci_runs(self):
        shards = int(re.search(r'--shard "\$DESKTOP_SHARD/(\d+)"', self.workflow).group(1))
        verifier = (self.root / "scripts" / "verify-desktop-test-shards.py").read_text()
        default = re.search(r'add_argument\("--shards", type=int, default=(\d+)\)', verifier)
        self.assertEqual(int(default.group(1)), shards)


class ReporterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = str((Path(self.tmp.name) / "one_test.dart").resolve())

    def report(self, events, selected=None, done=True):
        log = Path(self.tmp.name) / "flutter.log"
        lines = events + ([{"type": "done", "success": done}] if done is not None else [])
        log.write_text("Flutter build output\n" + "\n".join(json.dumps(e) for e in lines))
        return driver.summarize(log, selected or [self.path])

    def candidates(self, report, **overrides):
        return driver.retry_files(dict(status="failed", exit_code=1, **overrides), report)

    def test_passes_and_skips_require_every_registered_case(self):
        report = self.report(suite(self.path))
        self.assertTrue(driver.passed({"status": "passed"}, report))
        self.assertEqual(report["files"][self.path]["passed"], 1)
        self.assertEqual(report["files"][self.path]["skipped"], 1)
        self.assertFalse(driver.passed({"status": "passed"}, self.report(suite(self.path, behavior="incomplete"))))

    def test_only_exact_pre_registration_loader_failure_is_retryable(self):
        report = self.report(suite(self.path, behavior="loader"), done=False)
        self.assertEqual(self.candidates(report), [self.path])
        for behavior in ["assertion", "incomplete"]:
            self.assertEqual(self.candidates(self.report(suite(self.path, behavior=behavior), done=False)), [])
        events = suite(self.path, behavior="loader")
        events.insert(2, {"type": "group", "group": {"id": 10, "suiteID": 0, "parentID": None, "testCount": 1}})
        self.assertEqual(self.candidates(self.report(events, done=False)), [])

    def test_hidden_teardown_error_cannot_be_counted_as_a_passing_file(self):
        events = suite(self.path) + [
            {"type": "testStart", "test": {"id": 8, "suiteID": 0, "name": "(tearDownAll)", "groupIDs": [2]}},
            {"type": "error", "testID": 8, "error": "cleanup failed", "isFailure": False},
            {"type": "testDone", "testID": 8, "result": "error", "hidden": True, "skipped": False},
        ]
        report = self.report(events, done=False)
        self.assertEqual(report["files"][self.path]["status"], "failed_or_incomplete")
        self.assertEqual(self.candidates(report), [])

    def test_an_assertion_elsewhere_blocks_recovery(self):
        other = str((Path(self.tmp.name) / "other_test.dart").resolve())
        events = suite(self.path, behavior="loader") + suite(other, 10, "assertion")
        self.assertEqual(self.candidates(self.report(events, [self.path, other], done=False)), [])

    def test_missing_files_truncated_reporters_and_unknown_ids_fail_closed(self):
        events = suite(self.path, behavior="loader")
        for report in [self.report(events, done=None), self.report(events, [self.path, "/missing_test.dart"], done=False),
                       self.report(events + [{"type": "error", "testID": 999, "error": "unknown", "isFailure": False}], done=False)]:
            self.assertTrue(report["problems"])
            self.assertEqual(self.candidates(report), [])

    def test_bad_completion_and_duplicate_events_fail_closed(self):
        for changed in [dict(hidden=None), dict(result="unknown"), dict(skipped=None)]:
            events = suite(self.path)
            events[-1].update(changed)
            self.assertFalse(driver.passed({"status": "passed"}, self.report(events)))
        events = suite(self.path)
        self.assertFalse(driver.passed({"status": "passed"}, self.report(events + [events[-1]])))

    def test_timeout_cleanup_error_and_nonstandard_exit_are_not_retried(self):
        report = self.report(suite(self.path, behavior="loader"), done=False)
        for check in [{"status": "timeout", "exit_code": -9}, {"status": "failed", "exit_code": 2},
                      {"status": "failed", "exit_code": 1, "cleanup_error": "leftover child"}]:
            self.assertEqual(driver.retry_files(check, report), [])


@unittest.skipUnless(os.name == "posix", "owned process groups require POSIX")
class DesktopProcessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / ".harness").mkdir()
        (self.root / ".gitignore").write_text(".harness/\n__pycache__/\n")
        scripts = self.root / "scripts"
        scripts.mkdir()
        for name in ["test-desktop.py", "validate-change.py"]:
            shutil.copy2(SCRIPT.parent / name, scripts / name)
        tests = self.root / "desktop" / "test"
        tests.mkdir(parents=True)
        for name in ["one_test.dart", "two_test.dart"]:
            (tests / name).write_text("// fixture\n")
        (tests / "web").mkdir()
        (tests / "web" / "browser_test.dart").write_text("// browser-only fixture\n")
        self.flutter = self.root / "flutter"
        self.flutter.write_text(f"#!{sys.executable}\n" + Path(__file__).with_name("desktop_vm_fixture.py").read_text())
        self.flutter.chmod(0o755)
        for args in [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]]:
            subprocess.run(["git", *args], cwd=self.root, capture_output=True, check=True)

    def run_driver(self, scenario="pass", extra=()):
        (self.root / ".harness" / "scenario").write_text(scenario)
        result = subprocess.run([sys.executable, str(self.root / "scripts" / "test-desktop.py"),
                                 "--flutter", str(self.flutter), "--timeout", "10", *extra],
                                cwd=self.root, capture_output=True, text=True, timeout=20)
        receipts = sorted((self.root / ".harness" / "validation").glob("*/receipt.json"))
        receipt = json.loads(receipts[-1].read_text()) if receipts else None
        calls = self.root / ".harness" / "calls.jsonl"
        commands = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
        return result, receipt, commands

    def test_success_records_complete_vm_coverage_and_does_not_run_browser(self):
        result, receipt, calls = self.run_driver()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(receipt["coverage"], {"files": 2, "verified_files": 2, "passed": 2, "skipped": 2})
        self.assertEqual(len(calls), 1)
        self.assertFalse(any("browser_test" in arg for arg in calls[0]))
        self.assertEqual(receipt["source"], receipt["source_after"])
        self.assertEqual(receipt["identity"], receipt["identity_after"])

    def test_shard_executes_only_its_files_and_records_the_full_inventory(self):
        result, receipt, calls = self.run_driver(extra=("--shard", "2/2"))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt["shard"], dict(index=2, total=2, inventory=["test/one_test.dart", "test/two_test.dart"]))
        self.assertEqual([Path(p).name for p in receipt["selected_files"]], ["two_test.dart"])
        self.assertEqual([Path(p).name for p in calls[0] if p.endswith("_test.dart")], ["two_test.dart"])
        self.assertEqual(receipt["coverage"], dict(files=1, verified_files=1, passed=1, skipped=1))

    def test_recovery_runs_only_the_failed_loader_once_and_preserves_both_logs(self):
        result, receipt, calls = self.run_driver("once")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt["status"], "passed_after_startup_retry")
        self.assertEqual(len(calls), 2)
        self.assertIn("--concurrency=1", calls[1])
        self.assertEqual([Path(arg).name for arg in calls[1] if arg.endswith("_test.dart")], ["one_test.dart"])
        self.assertEqual(receipt["coverage"]["verified_files"], 2)
        self.assertEqual(receipt["checks"][0]["status"], "failed")
        for check in receipt["checks"]:
            self.assertTrue(Path(check["log"]).is_file())
            self.assertEqual(check["log_sha256"], driver.validation.file_sha256(Path(check["log"])))

    def test_repeated_loader_error_stops_after_one_retry(self):
        result, receipt, calls = self.run_driver("always")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(len(calls), 2)

    def test_assertions_and_incomplete_successful_processes_are_never_retried(self):
        for scenario in ["assertion", "incomplete", "truncated"]:
            with self.subTest(scenario=scenario):
                result, receipt, calls = self.run_driver(scenario)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(receipt["status"], "failed")
                self.assertEqual(len(receipt["checks"]), 1)

    def test_source_change_blocks_recovery(self):
        result, receipt, calls = self.run_driver("edit")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["status"], "source_changed")
        self.assertEqual(len(calls), 1)

    def test_opt_out_leaves_startup_failure_visible_without_retry(self):
        result, receipt, calls = self.run_driver("once", ["--no-loader-retry"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(receipt["status"], "failed")

    def test_explicit_browser_file_is_rejected_before_start(self):
        result, receipt, calls = self.run_driver(extra=["test/web/browser_test.dart"])
        self.assertEqual(result.returncode, 2)
        self.assertIn("separate Chrome command", result.stderr)
        self.assertIsNone(receipt)
        self.assertEqual(calls, [])

    def test_timeout_does_not_grant_a_fresh_budget_for_recovery(self):
        result, receipt, calls = self.run_driver("budget", ["--timeout", "1"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(receipt["checks"][0]["status"], "timeout")
        self.assertLess(receipt["duration_seconds"], 5)


    def test_a_shard_out_of_time_names_the_files_it_did_not_reach(self):
        """Task #3458: shard 3 hit its limit with a few files never reached, and nothing said which."""
        result, receipt, calls = self.run_driver("partial", ["--timeout", "2"])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["checks"][0]["status"], "timeout")
        self.assertEqual(receipt["unreached_files"], ["test/two_test.dart"])
        self.assertIn("Not reached before the time limit (1 file): test/two_test.dart", result.stdout)
        self.assertIn("::error title=Desktop shard out of time::", result.stdout)
        self.assertNotIn("one_test.dart", result.stdout.split("Not reached", 1)[1].splitlines()[0])

    def test_a_run_that_finishes_names_no_unreached_files(self):
        result, receipt, calls = self.run_driver()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt.get("unreached_files"), [])
        self.assertNotIn("Not reached", result.stdout)


if __name__ == "__main__":
    unittest.main()
