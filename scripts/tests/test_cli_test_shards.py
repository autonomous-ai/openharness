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


if __name__ == "__main__":
    unittest.main()
