import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "validate-change.py"
spec = importlib.util.spec_from_file_location("validate_change", SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


@unittest.skipUnless(os.name == "posix", "process groups require POSIX")
class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / ".harness").mkdir()
        (self.root / ".gitignore").write_text(".harness/\n")
        (self.root / "source.txt").write_text("original\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.STDOUT)

    def check(self, name, code, timeout=3):
        return {"name": name, "argv": [sys.executable, "-c", code], "timeout_seconds": timeout}

    def run_plan(self, checks, minimum=0, reuse=None, env=None):
        plan = self.root / ".harness" / "plan.json"
        plan.write_text(json.dumps({"reason": "Validation runner integration fixtures", "minimum_free_gib": minimum, "checks": checks}))
        command = [sys.executable, str(SCRIPT), str(plan)]
        if reuse:
            command.extend(["--reuse", str(reuse)])
        result = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=15, env=env)
        paths = sorted((self.root / ".harness" / "validation").glob("*/receipt.json"))
        self.assertTrue(paths, result.stderr + result.stdout)
        self.last_receipt = paths[-1]
        return result, json.loads(paths[-1].read_text())

    def counted_check(self, name="counted"):
        check = self.check(name, "from pathlib import Path; p=Path('.harness/count'); p.write_text(str(int(p.read_text())+1) if p.exists() else '1'); print('checked')")
        check["reuse"] = {"inputs": ["source.txt"], "toolchain": [[sys.executable, "--version"]]}
        return check

    def test_independent_checks_really_overlap_and_capture_logs(self):
        checks = []
        for name, other in [("one", "two"), ("two", "one")]:
            checks.append(self.check(name, f"from pathlib import Path; import time\nPath('.harness/{name}').touch()\nwhile not Path('.harness/{other}').exists(): time.sleep(.02)\nprint('{name} finished')"))
        result, receipt = self.run_plan(checks)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(len(receipt["checks"]), 2)
        for check in receipt["checks"]:
            self.assertIn("finished", Path(check["log"]).read_text())
            self.assertGreater(check["duration_seconds"], 0)
        self.assertEqual(receipt["source"], receipt["source_after"])

    def test_failure_does_not_hide_other_results(self):
        result, receipt = self.run_plan([self.check("bad", "import sys; sys.exit(7)"), self.check("good", "print('ok')")])
        self.assertEqual(result.returncode, 1)
        checks = {c["name"]: c for c in receipt["checks"]}
        self.assertEqual(checks["bad"]["exit_code"], 7)
        self.assertEqual(checks["good"]["status"], "passed")

    def test_timeout_kills_owned_children_even_if_parent_exits_on_term(self):
        child = "import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True:\n with Path('.harness/beats').open('a') as f: f.write('x')\n time.sleep(.02)"
        parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(30)"
        result, receipt = self.run_plan([self.check("stalled", parent, .5)])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["checks"][0]["status"], "timeout")
        beats = self.root / ".harness" / "beats"
        size = beats.stat().st_size
        self.assertGreater(size, 0)
        time.sleep(.15)
        self.assertEqual(beats.stat().st_size, size, "a child fixture survived cleanup")

    def test_low_disk_blocks_before_starting_commands(self):
        result, receipt = self.run_plan([self.check("never", "from pathlib import Path; Path('.harness/ran').touch()")], minimum=10**9)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["status"], "blocked")
        self.assertEqual(receipt["checks"][0]["status"], "not_run")
        self.assertFalse((self.root / ".harness" / "ran").exists())

    def test_source_edit_invalidates_successful_checks(self):
        result, receipt = self.run_plan([self.check("edit", "from pathlib import Path; Path('source.txt').write_text('changed')")])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["checks"][0]["status"], "passed")
        self.assertEqual(receipt["status"], "source_changed")

    def test_untracked_file_content_is_part_of_fingerprint(self):
        new = self.root / "new.txt"
        new.write_text("one")
        before = runner.source_state(self.root)
        new.write_text("two")
        after = runner.source_state(self.root)
        self.assertEqual(before["commit"], after["commit"])
        self.assertNotEqual(before["working_changes_sha256"], after["working_changes_sha256"])
        self.assertTrue(after["dirty"])

    def test_missing_executable_is_blocked_not_passed(self):
        result, receipt = self.run_plan([{"name": "missing", "argv": ["/no/such/validation-tool"], "timeout_seconds": 1}])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["checks"][0]["status"], "blocked")

    def test_empty_plan_and_unsafe_log_names_are_rejected(self):
        for checks in [[], [self.check("../escape", "pass")]]:
            plan = self.root / ".harness" / "invalid.json"
            plan.write_text(json.dumps({"reason": "fixture", "checks": checks}))
            with self.assertRaises(ValueError):
                runner.read_plan(plan, self.root)

    def test_passed_evidence_survives_unrelated_commit_and_keeps_original_log(self):
        check = self.counted_check()
        result, original = self.run_plan([check])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        previous = self.last_receipt
        (self.root / "notes.md").write_text("unrelated documentation\n")
        self.git("add", "notes.md")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "docs only")
        result, receipt = self.run_plan([check], reuse=previous)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(receipt["checks"][0]["status"], "reused")
        self.assertEqual(receipt["checks"][0]["log"], original["checks"][0]["log"])
        self.assertNotEqual(receipt["source"]["commit"], original["source"]["commit"])
        self.assertEqual((self.root / ".harness/count").read_text(), "1")
        # Reuse chains retain the original execution duration, not a fictitious run.
        _, chained = self.run_plan([check], reuse=self.last_receipt)
        self.assertEqual(chained["checks"][0]["original_duration_seconds"], original["checks"][0]["duration_seconds"])

    def test_source_toolchain_environment_and_command_changes_each_rerun(self):
        check = self.counted_check()
        version = self.root / ".harness/tool-version"
        version.write_text("one")
        check["reuse"]["toolchain"] = [[sys.executable, "-c", "from pathlib import Path; print(Path('.harness/tool-version').read_text())"]]
        env = dict(os.environ, VALIDATION_FIXTURE_ENV="one")
        self.run_plan([check], env=env)
        changes = [
            lambda: (self.root / "source.txt").write_text("new source"),
            lambda: version.write_text("new toolchain"),
            lambda: env.update(VALIDATION_FIXTURE_ENV="two"),
            lambda: check["argv"].append("new argument"),
        ]
        for number, change in enumerate(changes, 2):
            previous = self.last_receipt
            change()
            result, receipt = self.run_plan([check], reuse=previous, env=env)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(receipt["checks"][0]["status"], "passed")
            self.assertEqual((self.root / ".harness/count").read_text(), str(number))

    def test_new_and_deleted_files_in_a_declared_directory_invalidate_evidence(self):
        folder = self.root / "component"
        folder.mkdir()
        (folder / "original.txt").write_text("original")
        self.git("add", "component")
        check = self.counted_check()
        check["reuse"]["inputs"] = ["component"]
        self.run_plan([check])
        previous = self.last_receipt
        (folder / "new.txt").write_text("untracked source")
        _, receipt = self.run_plan([check], reuse=previous)
        self.assertEqual(receipt["checks"][0]["status"], "passed")
        previous = self.last_receipt
        (folder / "original.txt").unlink()
        _, receipt = self.run_plan([check], reuse=previous)
        self.assertEqual(receipt["checks"][0]["status"], "passed")
        self.assertEqual((self.root / ".harness/count").read_text(), "3")

    def test_failed_checks_rerun_without_repeating_independent_passes(self):
        good = self.counted_check()
        bad = self.check("failed", "raise SystemExit(7)")
        bad["reuse"] = good["reuse"]
        self.run_plan([good, bad])
        result, receipt = self.run_plan([good, bad], reuse=self.last_receipt)
        self.assertEqual(result.returncode, 1)
        checks = {item["name"]: item for item in receipt["checks"]}
        self.assertEqual(checks["counted"]["status"], "reused")
        self.assertEqual(checks["failed"]["status"], "failed")
        self.assertEqual((self.root / ".harness/count").read_text(), "1")

    def test_missing_or_tampered_logs_and_changing_source_are_not_reusable(self):
        check = self.counted_check()
        _, receipt = self.run_plan([check])
        previous = self.last_receipt
        Path(receipt["checks"][0]["log"]).write_text("different evidence")
        _, receipt = self.run_plan([check], reuse=previous)
        self.assertEqual(receipt["checks"][0]["status"], "passed")
        previous = self.last_receipt
        Path(receipt["checks"][0]["log"]).unlink()
        _, receipt = self.run_plan([check], reuse=previous)
        self.assertEqual(receipt["checks"][0]["status"], "passed")
        # This edit is outside the declared inputs, so only the unstable source
        # receipt (not a different per-check key) prevents reuse on the next run.
        check["argv"][2] += "; Path('unrelated.txt').write_text('changed during check')"
        _, receipt = self.run_plan([check])
        self.assertEqual(receipt["status"], "source_changed")
        _, receipt = self.run_plan([check], reuse=self.last_receipt)
        self.assertEqual(receipt["checks"][0]["status"], "passed")
        self.assertEqual((self.root / ".harness/count").read_text(), "5")

    def test_toolchain_failure_saves_a_blocked_receipt_before_tests_start(self):
        check = self.counted_check()
        check["reuse"]["toolchain"] = [[sys.executable, "-c", "raise SystemExit(4)"]]
        result, receipt = self.run_plan([check])
        self.assertEqual(result.returncode, 1)
        self.assertEqual(receipt["status"], "blocked")
        self.assertEqual(receipt["checks"][0]["status"], "not_run")
        self.assertFalse((self.root / ".harness/count").exists())

    def test_finished_empty_group_is_not_signaled(self):
        process = mock.Mock(pid=12345)
        process.poll.return_value = 0
        with mock.patch.object(runner.subprocess, "check_output", return_value=" 999\n"), mock.patch.object(runner.os, "killpg", side_effect=PermissionError("macOS denied")) as kill:
            self.assertIsNone(runner.stop_group(process))
            kill.assert_not_called()

    def test_finished_parent_does_not_leave_its_fixture_child_running(self):
        child = "import signal,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN)\nwhile True:\n with Path('.harness/beats').open('a') as f: f.write('x')\n time.sleep(.02)"
        parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', {child!r}]); time.sleep(.15)"
        result, receipt = self.run_plan([self.check("exited", parent)])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        size = (self.root / ".harness/beats").stat().st_size
        self.assertGreater(size, 0)
        time.sleep(.15)
        self.assertEqual((self.root / ".harness/beats").stat().st_size, size)

    def test_cleanup_errors_preserve_results_and_cannot_report_a_pass(self):
        output = self.root / ".harness"
        with mock.patch.object(runner, "stop_group", return_value="permission denied"):
            checks = runner.run_checks({"checks": [self.check("complete", "print('all tests finished')")]}, self.root, output, 1)
        self.assertEqual(checks[0]["status"], "cleanup_failed")
        self.assertEqual(checks[0]["exit_code"], 0)
        self.assertEqual(checks[0]["cleanup_error"], "permission denied")
        self.assertIn("all tests finished", Path(checks[0]["log"]).read_text())


if __name__ == "__main__":
    unittest.main()
