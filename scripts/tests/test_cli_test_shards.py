import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "verify-cli-test-shards.py"
spec = importlib.util.spec_from_file_location("cli_shards", SCRIPT)
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ShardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name).resolve()
        self.root = self.directory / "cli"
        self.names = [str(self.root / "src" / f"case-{i}.spec.ts") for i in range(4)]
        for number in range(1, 5):
            self.write(f"inventory-{number}.json", [{"file": path} for path in self.names])
            self.write(f"result-{number}.json", {
                "success": True, "numFailedTests": 0, "numFailedTestSuites": 0, "numPendingTestSuites": 0,
                "numPassedTests": 1, "numPendingTests": 1, "numTodoTests": 0, "numTotalTests": 2,
                "testResults": [{"name": self.names[number - 1], "status": "passed", "message": "",
                                 "assertionResults": [{"status": "passed", "failureMessages": []},
                                                      {"status": "skipped", "failureMessages": []}]}],
            })

    def write(self, name, value):
        (self.directory / name).write_text(json.dumps(value))

    def edit(self, name, change):
        data = json.loads((self.directory / name).read_text())
        change(data)
        self.write(name, data)

    def verify(self, tests="success", contracts="success"):
        return verifier.verify(self.directory, self.root, 4, tests, contracts)

    def test_complete_partition_preserves_pass_skip_counts_and_hashes(self):
        result = self.verify()
        self.assertEqual((result["files"], result["passed"], result["skipped"]), (4, 4, 4))
        self.assertEqual(len(result["verified_files"]), 4)
        self.assertTrue(all(len(shard["result_sha256"]) == 64 for shard in result["shards"]))

    def test_duplicate_file_cannot_replace_a_missing_file(self):
        self.edit("result-4.json", lambda r: r["testResults"][0].update(name=self.names[0]))
        with self.assertRaisesRegex(ValueError, "partition mismatch"):
            self.verify()

    def test_all_discovery_inventories_must_agree(self):
        self.edit("inventory-2.json", lambda paths: paths.pop())
        with self.assertRaisesRegex(ValueError, "inventories disagree"):
            self.verify()

    def test_missing_report_is_not_an_empty_passing_shard(self):
        (self.directory / "result-3.json").unlink()
        with self.assertRaises(FileNotFoundError):
            self.verify()

    def test_json_success_cannot_override_nonpassing_jobs(self):
        for state in ["failure", "cancelled", "skipped", ""]:
            for tests, contracts in [(state, "success"), ("success", state)]:
                with self.subTest(tests=tests, contracts=contracts), self.assertRaisesRegex(ValueError, "upstream jobs"):
                    self.verify(tests, contracts)

    def test_failed_or_unfinished_assertion_is_rejected(self):
        for state in ["failed", "pending", "running", None]:
            self.edit("result-1.json", lambda r: r["testResults"][0]["assertionResults"][0].update(status=state))
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, "unfinished case"):
                self.verify()

    def test_hidden_file_error_is_rejected_even_if_all_cases_pass(self):
        self.edit("result-1.json", lambda r: r["testResults"][0].update(message="afterAll failed"))
        with self.assertRaisesRegex(ValueError, "file failed"):
            self.verify()

    def test_inconsistent_or_invalid_case_totals_are_rejected(self):
        for value in [3, True, "2", None]:
            self.edit("result-1.json", lambda r: r.update(numTotalTests=value))
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "counts disagree"):
                self.verify()

    def test_file_outside_cli_cannot_count_as_suite_coverage(self):
        self.edit("result-1.json", lambda r: r["testResults"][0].update(name="/unrelated/src/case-0.spec.ts"))
        with self.assertRaises(ValueError):
            self.verify()

    def test_unfinished_suite_fails_even_with_passing_cases(self):
        self.edit("result-1.json", lambda r: r.update(numPendingTestSuites=1))
        with self.assertRaisesRegex(ValueError, "unfinished tests/suites"):
            self.verify()

    def test_command_writes_a_verified_summary_and_fails_on_incomplete_artifacts(self):
        output = self.directory / "summary.json"
        command = [sys.executable, str(SCRIPT), str(self.directory), "--root", str(self.root),
                   "--shards", "4", "--tests-result", "success", "--contracts-result", "success", "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text())["files"], 4)
        output.unlink()
        (self.directory / "result-2.json").unlink()
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertFalse(output.exists())

    def test_durations_are_recorded_rounded_up_for_the_next_runs_hints(self):
        self.edit("result-1.json", lambda r: r["testResults"][0].update(startTime=1_000, endTime=2_201))
        self.edit("result-2.json", lambda r: r["testResults"][0].update(startTime=5, endTime="late"))
        result = self.verify()
        self.assertEqual(result["durations_ms"], {"src/case-0.spec.ts": 1300})
        self.assertEqual(result["suite"], "unit")

    def test_the_unit_suite_still_requires_its_contract_job(self):
        with self.assertRaisesRegex(ValueError, "upstream jobs"):
            self.verify(contracts=None)


class EndToEndShardTests(ShardTests):
    """The same contract for the end-to-end suite: its own folder and names, and no contract job."""

    def setUp(self):
        super().setUp()
        self.names = [str(self.root / "e2e" / f"case-{i}.e2e.ts") for i in range(4)]
        for number in range(1, 5):
            self.edit(f"inventory-{number}.json", lambda paths: [item.update(file=self.names[i]) for i, item in enumerate(paths)])
            self.edit(f"result-{number}.json", lambda r, n=number: r["testResults"][0].update(name=self.names[n - 1]))

    def verify(self, tests="success", contracts=None):
        return verifier.verify(self.directory, self.root, 4, tests, contracts, suite="e2e")

    def test_complete_partition_preserves_pass_skip_counts_and_hashes(self):
        result = self.verify()
        self.assertEqual((result["suite"], result["files"], result["passed"], result["skipped"]), ("e2e", 4, 4, 4))
        self.assertEqual(result["verified_files"], [f"e2e/case-{i}.e2e.ts" for i in range(4)])

    def test_json_success_cannot_override_nonpassing_jobs(self):
        for state in ["failure", "cancelled", "skipped", ""]:
            with self.subTest(tests=state), self.assertRaisesRegex(ValueError, "upstream jobs"):
                self.verify(state)
        # A contract verdict, when one is given, still has to be a pass.
        with self.assertRaisesRegex(ValueError, "upstream jobs"):
            self.verify("success", "failure")

    def test_the_unit_suite_still_requires_its_contract_job(self):
        self.assertEqual(self.verify(contracts="success")["files"], 4)

    def test_durations_are_recorded_rounded_up_for_the_next_runs_hints(self):
        self.edit("result-3.json", lambda r: r["testResults"][0].update(startTime=0, endTime=264_249))
        self.assertEqual(self.verify()["durations_ms"], {"e2e/case-2.e2e.ts": 264_300})

    def test_a_unit_spec_cannot_count_as_an_end_to_end_file_or_the_reverse(self):
        unit = str(self.root / "src" / "case-0.spec.ts")
        self.edit("result-1.json", lambda r: r["testResults"][0].update(name=unit))
        with self.assertRaisesRegex(ValueError, "unexpected test path"):
            self.verify()
        with self.assertRaisesRegex(ValueError, "unexpected test path"):
            verifier.verify(self.directory, self.root, 4, "success", "success")

    def test_command_writes_a_verified_summary_and_fails_on_incomplete_artifacts(self):
        output = self.directory / "summary.json"
        command = [sys.executable, str(SCRIPT), str(self.directory), "--root", str(self.root),
                   "--shards", "4", "--tests-result", "success", "--suite", "e2e", "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text())["files"], 4)
        output.unlink()
        # Without --suite it is the default suite, which needs its contract job's verdict.
        unit = [arg for arg in command if arg not in ("--suite", "e2e")]
        result = subprocess.run(unit, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--contracts-result", result.stderr)
        self.assertFalse(output.exists())


class SelectedFilesTests(unittest.TestCase):
    """A pull request's own e2e files: exactly the selected set ran, each collecting at least one case."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name).resolve()
        self.root = self.directory / "cli"
        self.files = {"e2e/a.e2e.ts": [("passed", "a works")],
                      "e2e/b.e2e.ts": [("passed", "b works"), ("skipped", "b skips on macOS")]}

    def write(self, shards=2):
        # Every shard discovers the same files; each file's results land on one shard.
        names = sorted(self.files)
        for shard in range(1, shards + 1):
            mine = names[shard - 1::shards]
            cases = [case for name in mine for case in self.files[name]]
            count = lambda status: sum(1 for state, _ in cases if state == status)
            (self.directory / f"inventory-{shard}.json").write_text(
                json.dumps([{"file": str(self.root / name)} for name in names]))
            (self.directory / f"result-{shard}.json").write_text(json.dumps({
                "success": True, "numFailedTests": 0, "numFailedTestSuites": 0, "numPendingTestSuites": 0,
                "numPassedTests": count("passed"), "numPendingTests": count("skipped"), "numTodoTests": 0,
                "numTotalTests": len(cases),
                "testResults": [{"name": str(self.root / name), "status": "passed", "message": "",
                                 "assertionResults": [{"status": state, "fullName": title, "failureMessages": []}
                                                      for state, title in self.files[name]]} for name in mine],
            }))

    def verify(self, selected=("e2e/a.e2e.ts", "e2e/b.e2e.ts"), shards=2, must_pass=None):
        self.write(shards)
        return verifier.verify(self.directory, self.root, shards, "success", None, suite="e2e",
                               selected=None if selected is None else list(selected), must_pass=must_pass)

    def command(self, *extra, suite="e2e"):
        self.write()
        command = [sys.executable, str(SCRIPT), str(self.directory), "--root", str(self.root), "--shards", "2",
                   "--tests-result", "success", "--contracts-result", "success", "--suite", suite,
                   "--output", str(self.directory / "summary.json"), *extra]
        return subprocess.run(command, capture_output=True, text=True, timeout=5)

    def test_selected_files_pass_with_each_files_skipped_cases_listed(self):
        summary = self.verify()
        self.assertEqual(summary["status"], "passed")
        self.assertEqual(summary["skipped_by_file"], {"e2e/b.e2e.ts": ["b skips on macOS"]})
        self.assertEqual(summary["all_skipped"], [])

    def test_a_selected_file_whose_every_case_skipped_passes_listed(self):
        self.files["e2e/b.e2e.ts"] = [("skipped", "b skips on macOS"), ("skipped", "b also skips")]
        summary = self.verify()
        self.assertEqual(summary["status"], "passed")
        self.assertEqual(summary["all_skipped"], ["e2e/b.e2e.ts"])

    def test_the_canary_whose_every_case_skipped_fails_naming_it(self):
        # The canary skips itself without the real backend: skipped there means the setup it checks broke.
        self.files["e2e/b.e2e.ts"] = [("skipped", "b without the real backend")]
        for selected in (("e2e/a.e2e.ts", "e2e/b.e2e.ts"), None):
            with self.subTest(selected=selected), self.assertRaisesRegex(
                    ValueError, r"e2e/b\.e2e\.ts must pass a case and skip none: 0 passed, 1 skipped"):
                self.verify(selected=selected, must_pass="e2e/b.e2e.ts")

    def test_the_canary_with_a_skipped_case_beside_a_passed_one_fails(self):
        with self.assertRaisesRegex(ValueError, r"e2e/b\.e2e\.ts must pass a case and skip none: 1 passed, 1 skipped"):
            self.verify(must_pass="e2e/b.e2e.ts")

    def test_the_canary_with_a_passed_case_and_no_skipped_one_passes(self):
        for selected in (("e2e/a.e2e.ts", "e2e/b.e2e.ts"), None):
            with self.subTest(selected=selected):
                self.assertEqual(self.verify(selected=selected, must_pass="e2e/a.e2e.ts")["status"], "passed")

    def test_a_canary_missing_from_the_run_fails_naming_it(self):
        for selected in (("e2e/a.e2e.ts", "e2e/b.e2e.ts"), None):
            with self.subTest(selected=selected), self.assertRaisesRegex(
                    ValueError, r"e2e/c\.e2e\.ts must pass a case, but the run has no such file"):
                self.verify(selected=selected, must_pass="e2e/c.e2e.ts")

    def test_the_command_fails_on_a_skipped_canary_and_takes_must_pass_for_the_end_to_end_suite_only(self):
        self.files["e2e/b.e2e.ts"] = [("skipped", "b without the real backend")]
        result = self.command("--selected", "e2e/a.e2e.ts e2e/b.e2e.ts", "--must-pass", "e2e/b.e2e.ts")
        self.assertEqual(result.returncode, 1)
        self.assertIn("e2e/b.e2e.ts must pass a case and skip none", result.stderr)
        self.assertEqual(self.command("--must-pass", "e2e/a.e2e.ts").returncode, 0)
        result = self.command("--must-pass", "e2e/a.e2e.ts", suite="unit")
        self.assertEqual(result.returncode, 2)
        self.assertIn("end-to-end suite", result.stderr)

    def test_a_selected_file_that_collected_no_test_fails_naming_it(self):
        self.files["e2e/b.e2e.ts"] = []
        with self.assertRaisesRegex(ValueError, r"collected no test: e2e/b\.e2e\.ts"):
            self.verify()

    def test_a_file_the_plan_did_not_select_fails(self):
        # Vitest's positional filters match substrings: e2e/a.e2e.ts also picks e2e/sub/a.e2e.ts.
        self.files["e2e/sub/a.e2e.ts"] = [("passed", "sub a works")]
        with self.assertRaisesRegex(ValueError, r"unexpected=\['e2e/sub/a\.e2e\.ts'\]"):
            self.verify()

    def test_a_selected_file_missing_from_the_run_fails(self):
        with self.assertRaisesRegex(ValueError, r"missing=\['e2e/c\.e2e\.ts'\]"):
            self.verify(selected=("e2e/a.e2e.ts", "e2e/b.e2e.ts", "e2e/c.e2e.ts"))

    def test_a_selected_file_that_failed_to_load_fails(self):
        self.write()
        result = self.directory / "result-1.json"
        report = json.loads(result.read_text())
        report["testResults"][0] = {"name": str(self.root / "e2e/a.e2e.ts"), "status": "failed",
                                    "message": "Failed to load url ./missing"}
        report.update(success=False, numFailedTestSuites=1, numPassedTests=0, numTotalTests=0)
        result.write_text(json.dumps(report))
        # Named, not only the shard's failed flag.
        with self.assertRaisesRegex(ValueError, r"file failed: e2e/a\.e2e\.ts"):
            verifier.verify(self.directory, self.root, 2, "success", None, suite="e2e",
                            selected=["e2e/a.e2e.ts", "e2e/b.e2e.ts"])

    def test_selected_is_for_the_end_to_end_suite_only(self):
        for extra in (("--selected", "e2e/a.e2e.ts"), ("--step-summary", str(self.directory / "step.md"))):
            with self.subTest(extra=extra[0]):
                result = self.command(*extra, suite="unit")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("usage:", result.stderr)
                self.assertIn("end-to-end suite", result.stderr)

    def test_the_step_summary_lists_the_skipped_cases_per_file(self):
        step = self.directory / "step.md"
        result = self.command("--selected", "e2e/a.e2e.ts e2e/b.e2e.ts", "--step-summary", str(step))
        self.assertEqual(result.returncode, 0, result.stderr)
        text = step.read_text()
        self.assertIn("| e2e/b.e2e.ts | 1 | 1 |", text)
        self.assertIn("b skips on macOS", text)
        self.assertNotIn("Every case skipped", text)

    def test_the_step_summary_says_macos_only_files_are_not_verified(self):
        self.files["e2e/c.e2e.ts"] = [("skipped", "c runs on macOS only")]
        for selected in (("--selected", "e2e/a.e2e.ts e2e/b.e2e.ts e2e/c.e2e.ts"), ()):
            with self.subTest(selected=bool(selected)):
                step = self.directory / f"step-{bool(selected)}.md"
                result = self.command(*selected, "--step-summary", str(step))
                self.assertEqual(result.returncode, 0, result.stderr)
                text = step.read_text()
                self.assertIn("Every case skipped", text)
                self.assertIn("e2e/c.e2e.ts", text)
                self.assertIn("macOS-only files are not verified by PR CI.", text)


if __name__ == "__main__":
    unittest.main()
