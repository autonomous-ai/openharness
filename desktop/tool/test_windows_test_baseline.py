#!/usr/bin/env python3
"""Tests for windows_test_baseline.py. Run: python3 desktop/tool/test_windows_test_baseline.py"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import windows_test_baseline as baseline  # noqa: E402


def run_log(directory, tests, done=True):
    """A `flutter test --file-reporter json:...` log. tests: (file, name, result), where result is
    success, failure, error or skipped."""
    events, suites = [], {}
    for index, (file, name, result) in enumerate(tests):
        if file not in suites:
            suites[file] = len(suites)
            windows_path = "D:\\a\\repo\\desktop\\" + file.replace("/", "\\")
            events.append({"type": "suite", "suite": {"id": suites[file], "platform": "vm", "path": windows_path}})
        events.append({"type": "testStart", "test": {"id": index, "name": name, "suiteID": suites[file]}})
        events.append({
            "type": "testDone",
            "testID": index,
            "result": "success" if result == "skipped" else result,
            "skipped": result == "skipped",
            "hidden": name.startswith("loading "),
        })
    if done:
        events.append({"type": "done", "success": False})
    path = Path(directory) / f"run-{len(list(Path(directory).iterdir()))}.json"
    path.write_text("Building flutter tool...\n" + "\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    return str(path)


class BaselineTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.baseline = Path(self.dir.name) / "known.txt"
        self.baseline.write_text(baseline.HEADER + "test/posix_test.dart::uses /bin/sh\n", encoding="utf-8")

    def check(self, *logs):
        lines = []
        code = baseline.check(list(logs), str(self.baseline), out=lines.append)
        return code, "\n".join(lines)

    def test_a_recorded_failure_passes_and_a_new_one_fails(self):
        recorded = run_log(self.dir.name, [("test/posix_test.dart", "uses /bin/sh", "failure"), ("test/a_test.dart", "works", "success")])
        self.assertEqual(self.check(recorded)[0], 0)
        new = run_log(self.dir.name, [("test/posix_test.dart", "uses /bin/sh", "failure"), ("test/a_test.dart", "works", "error")])
        code, out = self.check(new)
        self.assertEqual(code, 1)
        self.assertIn("new failure: test/a_test.dart::works", out)

    def test_a_must_pass_file_fails_even_when_recorded(self):
        entry = "test/home_dir_test.dart::homeDir is USERPROFILE on Windows"
        self.baseline.write_text(baseline.HEADER + entry + "\n", encoding="utf-8")
        log = run_log(self.dir.name, [("test/home_dir_test.dart", "homeDir is USERPROFILE on Windows", "failure")])
        code, out = self.check(log)
        self.assertEqual(code, 1)
        self.assertIn("must pass on Windows: " + entry, out)

    def test_a_file_that_does_not_load_is_a_failure(self):
        log = run_log(self.dir.name, [("test/b_test.dart", "loading D:\\a\\repo\\desktop\\test\\b_test.dart", "error")])
        code, out = self.check(log)
        self.assertEqual(code, 1)
        self.assertIn("new failure: test/b_test.dart::(loading)", out)

    def test_a_run_that_did_not_finish_fails(self):
        log = run_log(self.dir.name, [("test/a_test.dart", "works", "success")], done=False)
        code, out = self.check(log)
        self.assertEqual(code, 1)
        self.assertIn("did not finish", out)

    def test_premature_reporter_done_status_fails_check_and_write(self):
        for done in [{"type": "done", "success": None}, {"type": "done"}]:
            with self.subTest(done=done):
                log = run_log(self.dir.name, [("test/posix_test.dart", "uses /bin/sh", "failure")])
                lines = Path(log).read_text(encoding="utf-8").splitlines()
                lines[-1] = json.dumps(done)
                Path(log).write_text("\n".join(lines) + "\n", encoding="utf-8")
                code, out = self.check(log)
                self.assertEqual(code, 1)
                self.assertIn("did not finish", out)
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(baseline.write([log], out=lambda _: None), 1)

    def test_started_tests_without_outcomes_fail_even_with_successful_done(self):
        for file in ["test/home_dir_test.dart", "test/shared_test.dart"]:
            with self.subTest(file=file):
                log = run_log(self.dir.name, [(file, "unfinished", "success")])
                lines = [line for line in Path(log).read_text(encoding="utf-8").splitlines()
                         if '"type": "testDone"' not in line]
                lines[-1] = json.dumps({"type": "done", "success": True})
                Path(log).write_text("\n".join(lines) + "\n", encoding="utf-8")
                code, out = self.check(log)
                self.assertEqual(code, 1)
                self.assertIn("did not finish", out)
                with contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(baseline.write([log], out=lambda _: None), 1)

    def test_completed_successful_and_recorded_failed_runs_remain_complete(self):
        failed = run_log(self.dir.name, [("test/posix_test.dart", "uses /bin/sh", "failure")])
        self.assertEqual(self.check(failed)[0], 0)
        self.assertEqual(baseline.write([failed], out=lambda _: None), 0)
        passed = run_log(self.dir.name, [("test/shared_test.dart", "finished", "success")])
        lines = Path(passed).read_text(encoding="utf-8").splitlines()
        lines[-1] = json.dumps({"type": "done", "success": True})
        Path(passed).write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.assertEqual(self.check(passed)[0], 0)
        self.assertEqual(baseline.write([passed], out=lambda _: None), 0)

    def test_skips_are_not_failures_and_a_fixed_test_is_named(self):
        log = run_log(self.dir.name, [("test/posix_test.dart", "uses /bin/sh", "success"), ("test/w_test.dart", "on Windows", "skipped")])
        code, out = self.check(log)
        self.assertEqual(code, 0)
        self.assertIn("passes on Windows now", out)

    def test_two_architectures_fail_a_test_that_fails_on_either(self):
        x64 = run_log(self.dir.name, [("test/a_test.dart", "works", "success")])
        arm64 = run_log(self.dir.name, [("test/a_test.dart", "works", "failure")])
        self.assertEqual(self.check(x64, arm64)[0], 1)

    def test_write_records_failures_but_refuses_a_must_pass_one(self):
        lines = []
        log = run_log(self.dir.name, [("test/posix_test.dart", "uses /bin/sh", "failure")])
        self.assertEqual(baseline.write([log], out=lines.append), 0)
        self.assertEqual(lines[-1], "test/posix_test.dart::uses /bin/sh")
        must = run_log(self.dir.name, [("test/viewer_mode_test.dart", "x", "failure")])
        self.assertEqual(baseline.write([must], out=lambda _: None), 1)

    def test_show_lists_one_file_with_skips(self):
        lines = []
        log = run_log(self.dir.name, [("test/w_test.dart", "on Windows a", "skipped"), ("test/w_test.dart", "b", "success")])
        baseline.show([log], "test/w_test.dart", out=lines.append)
        self.assertEqual(lines, ["skipped test/w_test.dart::on Windows a", "success test/w_test.dart::b"])


if __name__ == "__main__":
    unittest.main()
