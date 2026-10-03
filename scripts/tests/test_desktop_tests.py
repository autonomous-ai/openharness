import importlib.util
import json
import os
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


if __name__ == "__main__":
    unittest.main()
