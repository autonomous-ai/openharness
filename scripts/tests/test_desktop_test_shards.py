import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from desktop_vm_fixture import suite

spec = importlib.util.spec_from_file_location("desktop_shards", Path(__file__).resolve().parents[1] / "verify-desktop-test-shards.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class DesktopShardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve() / "source"
        tests = self.root / "desktop/test"
        tests.mkdir(parents=True)
        for name in ["one", "two"]:
            (tests / f"{name}_test.dart").write_text("// fixture\n")
        for args in [["init", "-q"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]]:
            subprocess.run(["git", *args], cwd=self.root, capture_output=True, check=True)
        self.source = verifier.driver.validation.source_state(self.root)
        self.directory = self.root.parent / "reports"
        self.records = []
        self.inventory = ["test/one_test.dart", "test/two_test.dart"]
        for label, platform in verifier.PLATFORMS.items():
            for index in [1, 2]:
                folder = self.directory / f"desktop-shard-{label}-{index}" / "run"
                folder.mkdir(parents=True)
                desktop = f"/producer/{label}/desktop"
                selected = [desktop + "/" + self.inventory[index - 1]]
                check = self.check(folder, selected, "desktop-vm")
                record = dict(schema=1, kind="desktop-vm", platform=platform, source=self.source,
                              source_after=self.source, identity={"tool": "same"}, identity_after={"tool": "same"},
                              desktop_root=desktop, selected_files=selected, checks=[check], status="passed",
                              coverage=dict(files=1, verified_files=1, passed=1, skipped=1),
                              shard=dict(index=index, total=2, inventory=self.inventory))
                path = folder / "receipt.json"
                self.write(path, record)
                self.records.append((path, record))

    def write(self, path, record):
        path.write_text(json.dumps(record))

    def check(self, folder, selected, name, behavior="pass"):
        log = folder / (name + ".log")
        events = suite(selected[0], behavior=behavior) + [dict(type="done", success=behavior == "pass")]
        log.write_text("\n".join(json.dumps(e) for e in events) + "\n")
        return dict(name=name, status="passed" if behavior == "pass" else "failed",
                    exit_code=0 if behavior == "pass" else 1, log="/producer/" + log.name,
                    log_sha256=verifier.driver.validation.file_sha256(log),
                    report=verifier.driver.summarize(log, selected))

    def verify(self, result="success"):
        return verifier.verify(self.directory, self.root, 2, result)

    def test_complete_logs_cover_each_platform_once_with_separate_counts(self):
        result = self.verify()
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["source"], self.source)
        self.assertEqual(len(result["platforms"]), 2)
        for platform in result["platforms"]:
            self.assertEqual(platform["verified_files"], self.inventory)
            self.assertEqual((platform["files"], platform["passed"], platform["skipped"]), (2, 2, 2))

    def test_failed_matrix_cannot_be_hidden_by_passing_reports(self):
        for result in ["failure", "cancelled", "skipped", ""]:
            with self.subTest(result=result), self.assertRaises(ValueError):
                self.verify(result)

    def test_missing_and_extra_artifacts_are_rejected(self):
        extra = self.directory / "desktop-shard-macos-15-3"
        extra.mkdir()
        with self.assertRaises(ValueError):
            self.verify()
        extra.rmdir()
        self.records[0][0].unlink()
        with self.assertRaises(ValueError):
            self.verify()

    def test_source_platform_assignment_inventory_and_counts_must_agree(self):
        path, original = self.records[0]
        changes = [dict(source=dict(self.source, commit="f" * 40)), dict(platform="other"),
                   dict(identity_after={"tool": "changed"}), dict(selected_files=["/outside/test.dart"]),
                   dict(shard=dict(index=2, total=2, inventory=self.inventory)),
                   dict(shard=dict(index=1, total=2, inventory=self.inventory[:1])),
                   dict(coverage=dict(files=1, verified_files=1, passed=999, skipped=1))]
        for change in changes:
            with self.subTest(change=change):
                self.write(path, dict(original, **change))
                with self.assertRaises(ValueError):
                    self.verify()
        self.write(path, original)

    def test_changed_log_or_summary_does_not_pass(self):
        path, original = self.records[0]
        modified = copy.deepcopy(original)
        modified["checks"][0]["report"]["reported_success"] = False
        self.write(path, modified)
        with self.assertRaises(ValueError):
            self.verify()
        self.write(path, original)
        (path.parent / "desktop-vm.log").write_text("truncated\n")
        with self.assertRaises(ValueError):
            self.verify()

    def test_raw_failure_or_incomplete_report_cannot_claim_success(self):
        path, original = self.records[0]
        for behavior in ["assertion", "incomplete", "loader"]:
            with self.subTest(behavior=behavior):
                record = copy.deepcopy(original)
                check = self.check(path.parent, record["selected_files"], "desktop-vm", behavior)
                check.update(status="passed", exit_code=0)
                record["checks"] = [check]
                self.write(path, record)
                with self.assertRaises(ValueError):
                    self.verify()

    def test_only_the_existing_narrow_loader_recovery_is_accepted(self):
        path, record = self.records[0]
        record = copy.deepcopy(record)
        record["checks"] = [self.check(path.parent, record["selected_files"], "desktop-vm", "loader"),
                            self.check(path.parent, record["selected_files"], "desktop-vm-loader-retry")]
        record.update(status="passed_after_startup_retry", retried_files=record["selected_files"])
        self.write(path, record)
        result = self.verify()
        self.assertEqual(result["platforms"][0]["shards"][0]["recovered_files"], ["test/one_test.dart"])
        record["checks"][0] = self.check(path.parent, record["selected_files"], "desktop-vm", "assertion")
        self.write(path, record)
        with self.assertRaises(ValueError):
            self.verify()

    def test_cleanup_failure_blocks_aggregation(self):
        path, record = self.records[0]
        record = copy.deepcopy(record)
        record["checks"][0]["cleanup_error"] = "child remained"
        self.write(path, record)
        with self.assertRaises(ValueError):
            self.verify()


if __name__ == "__main__":
    unittest.main()
