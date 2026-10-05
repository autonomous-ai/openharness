import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import zipfile

SCRIPT = Path(__file__).resolve().parents[1] / "record-ci-validation.py"
spec = importlib.util.spec_from_file_location("record_ci", SCRIPT)
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "source"
        self.root.mkdir()
        self.output = Path(self.tmp.name) / "evidence"
        self.output.mkdir()
        (self.root / "source.txt").write_text("tested\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "tested")
        self.sha = self.git("rev-parse", "HEAD")
        self.run = {"id": 123, "repository": {"full_name": "owner/repo"}, "path": ".github/workflows/ci.yml",
                    "head_sha": self.sha, "run_attempt": 1, "status": "completed", "conclusion": "success",
                    "html_url": "https://github.com/owner/repo/actions/runs/123",
                    "created_at": "2026-10-03T00:00:00Z", "updated_at": "2026-10-03T00:03:00Z"}
        self.jobs = [{"id": i, "name": name, "run_id": 123, "run_attempt": 1, "head_sha": self.sha,
                      "status": "completed", "conclusion": "success", "started_at": "2026-10-03T00:00:10Z",
                      "completed_at": "2026-10-03T00:02:59Z", "steps": []}
                     for i, name in enumerate(sorted(recorder.CLI_JOBS | {"process-checks"}), 1)]
        self.summary = {"schema": 1, "status": "passed", "files": 4, "passed": 4, "skipped": 0, "todo": 0,
                        "verified_files": [f"src/file-{i}.spec.ts" for i in range(4)],
                        "shards": [{"shard": i, "files": 1, "passed": 1, "skipped": 0, "todo": 0} for i in range(1, 5)]}
        self.archive = self.zip_summary(self.summary)
        self.artifact = {"id": 987, "name": "cli-test-summary", "expired": False, "size_in_bytes": len(self.archive),
                         "digest": "sha256:" + hashlib.sha256(self.archive).hexdigest(),
                         "workflow_run": {"id": 123, "head_sha": self.sha}}
        self.pr = {"html_url": "https://github.com/owner/repo/pull/5", "head": {"sha": self.sha}, "base": {"sha": self.sha}}
        self.after = None

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def zip_summary(self, summary, name="cli-test-summary.json"):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            archive.writestr(name, json.dumps(summary))
        return stream.getvalue()

    def collect(self, scope="cli", target="HEAD", with_pr=False, pr_after=None, expected_run=None):
        fixture = self

        class FakeClient:
            repository = "owner/repo"
            run_reads = 0
            pr_reads = 0

            def api(self, path):
                if path == "actions/runs/123":
                    self.run_reads += 1
                    return copy.deepcopy(fixture.after if self.run_reads > 1 and fixture.after else fixture.run)
                if path == "pulls/5":
                    self.pr_reads += 1
                    return copy.deepcopy(pr_after if self.pr_reads > 1 and pr_after else fixture.pr)
                raise AssertionError(path)

            def pages(self, path, key):
                return copy.deepcopy(fixture.jobs if key == "jobs" else getattr(fixture, "artifacts", [fixture.artifact]))

            def command(self, *args, binary=False):
                fixture.command_args = args
                return fixture.archives[args[-1]] if hasattr(fixture, "archives") else fixture.archive

        return recorder.collect(FakeClient(), self.root, 123, scope, target, self.output, 5 if with_pr else None, expected_run)

    def test_complete_record_checks_identity_digest_coverage_and_pr(self):
        result = self.collect(with_pr=True)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["workflow_seconds"], 180)
        self.assertEqual(result["cli_summary"]["passed"], 4)
        self.assertEqual(result["pr"]["head"], self.sha)
        self.assertEqual(self.command_args[-1], "repos/owner/repo/actions/artifacts/987/zip")
        self.assertIn("4 files verified exactly once", recorder.markdown(result))
        self.assertEqual((self.output / "cli-test-summary.zip").read_bytes(), self.archive)

    def test_process_scope_needs_no_cli_artifact(self):
        self.jobs = [job for job in self.jobs if job["name"] == "process-checks"]
        result = self.collect(scope="process")
        self.assertEqual(result["status"], "passed")
        self.assertNotIn("cli_summary", result)
        self.assertFalse((self.output / "cli-test-summary.zip").exists())

    def input_fixture(self, scope="process"):
        for path in (".github/workflows/ci.yml", "scripts/check.py", "desktop/scripts/upload.sh", "desktop/scripts/keep.py",
                     "cli/core.ts", "tests/fixtures/layout.json", "daemons/frames.json", "store/catalog.json", "docs/images/poster.png"):
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("tested input\n")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "bounded inputs")
        self.sha = self.git("rev-parse", "HEAD")
        self.run["head_sha"] = self.pr["head"]["sha"] = self.pr["base"]["sha"] = self.sha
        self.artifact["workflow_run"]["head_sha"] = self.sha
        for job in self.jobs:
            job["head_sha"] = self.sha
        if scope == "desktop":
            self.desktop_fixture()
        else:
            self.jobs = [job for job in self.jobs if job["name"] == "process-checks"]
        for job in self.jobs:
            job["steps"] = [dict(name=recorder.CHECKOUT_STEP, conclusion="success")]
        self.input_summary = dict(schema=1, kind="ci-source-inputs", status="recorded", source_sha=self.sha,
                                  source_tree=self.git("rev-parse", "HEAD^{tree}"), dirty=False, run_id=123, run_attempt=1,
                                  scopes={name: recorder.input_snapshot(self.root, self.sha, name) for name in recorder.SOURCE_INPUTS})
        self.input_artifact = dict(id=989, name="ci-source-inputs", expired=False,
                                   workflow_run=dict(id=123, head_sha=self.sha))
        self.artifacts = [self.artifact, self.input_artifact] if scope == "desktop" else [self.input_artifact]
        self.archives = {"repos/owner/repo/actions/artifacts/987/zip": self.archive}
        self.input_archive()

    def input_archive(self):
        archive = self.zip_summary(self.input_summary, "ci-source-inputs.json")
        self.archives["repos/owner/repo/actions/artifacts/989/zip"] = archive
        self.input_artifact.update(size_in_bytes=len(archive), digest="sha256:" + hashlib.sha256(archive).hexdigest())

    def change_source(self, path, content="changed\n"):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        self.commit_change()

    def commit_change(self):
        self.git("add", "-A")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "target change")
        self.pr["head"]["sha"] = self.git("rev-parse", "HEAD")

    def test_verified_process_inputs_allow_documentation_and_unrelated_component_changes(self):
        self.input_fixture()
        self.change_source("desktop/RELEASE.md")
        self.change_source("cli/src/memory/store.ts")
        result = self.collect(scope="process", with_pr=True)
        self.assertEqual(result["status"], "passed")
        self.assertFalse(result["source"]["same_tree"])
        self.assertTrue(result["scope_reuse"]["same_inputs"])
        self.assertIn("CI evidence reused", recorder.markdown(result))
        self.assertIn("not review or validation", recorder.markdown(result))
        self.assertTrue((self.output / "ci-source-inputs.zip").exists())

    def test_desktop_summary_and_inputs_both_cover_reuse_across_a_firmware_change(self):
        self.input_fixture("desktop")
        self.change_source("devices/firmware/main.c")
        result = self.collect(scope="desktop", with_pr=True)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(result["desktop_summary"]["source"]["commit"], self.sha)
        self.assertTrue(result["scope_reuse"]["same_inputs"])
        self.change_source("desktop/test/new_test.dart")
        self.assertEqual(self.collect(scope="desktop")["status"], "source_review_required")

    def test_desktop_shared_fixtures_protocols_and_catalogs_are_inputs(self):
        self.input_fixture("desktop")
        for path in ("cli/core.ts", "tests/fixtures/layout.json", "daemons/frames.json", "store/catalog.json",
                     "docs/images/poster.png", "mobile/pubspec.lock"):
            with self.subTest(path=path):
                self.git("reset", "--hard", self.sha)
                self.change_source(path)
                result = self.collect(scope="desktop")
                self.assertEqual(result["status"], "source_review_required")
                self.assertFalse(result["scope_reuse"]["same_inputs"])

    def test_changed_input_contents_additions_deletions_and_modes_invalidate_reuse(self):
        self.input_fixture()
        for path in ("scripts/check.py", ".github/workflows/ci.yml", "desktop/scripts/new.sh", ".gitattributes"):
            with self.subTest(path=path):
                self.git("reset", "--hard", self.sha)
                self.change_source(path)
                result = self.collect(scope="process")
                self.assertEqual(result["status"], "source_review_required")
                self.assertFalse(result["scope_reuse"]["same_inputs"])
        for mode in ("delete", "executable"):
            with self.subTest(mode=mode):
                self.git("reset", "--hard", self.sha)
                path = self.root / "desktop/scripts/upload.sh"
                if mode == "delete":
                    path.unlink()
                else:
                    path.chmod(0o755)
                self.commit_change()
                self.assertEqual(self.collect(scope="process")["status"], "source_review_required")

    def test_missing_input_receipt_keeps_different_source_unverified(self):
        self.input_fixture()
        self.artifacts = []
        self.change_source("docs/guide.md")
        self.assertEqual(self.collect(scope="process")["status"], "source_review_required")

    def test_source_receipt_cannot_lie_about_inputs_identity_or_checkout(self):
        self.input_fixture()
        original = copy.deepcopy(self.input_summary)
        for change in (dict(run_attempt=2), dict(run_id=True), dict(schema=True), dict(dirty=True),
                       dict(source_tree="b" * 40), dict(scopes=None), dict(scopes={}), dict(source_sha="b" * 40)):
            with self.subTest(change=change):
                self.input_summary = dict(original, **change)
                self.input_archive()
                with self.assertRaises(ValueError):
                    self.collect(scope="process")
        self.input_summary = original
        self.input_archive()
        self.jobs[0]["steps"][0]["conclusion"] = "skipped"
        with self.assertRaisesRegex(ValueError, "checkout was not verified"):
            self.collect(scope="process")

    def test_scoped_reuse_does_not_accept_dirty_work_or_a_different_pr_head(self):
        self.input_fixture()
        self.change_source("docs/guide.md")
        self.pr["head"]["sha"] = self.sha
        self.assertEqual(self.collect(scope="process", with_pr=True)["status"], "source_review_required")
        self.pr["head"]["sha"] = self.git("rev-parse", "HEAD")
        (self.root / "uncommitted.txt").write_text("unreviewed")
        self.assertEqual(self.collect(scope="process", with_pr=True)["status"], "source_review_required")

    def test_partial_rerun_keeps_the_receipt_bound_to_its_successful_process_job(self):
        self.input_fixture("desktop")
        self.run["run_attempt"] = 2
        for job in self.jobs:
            if job["name"] != "process-checks":
                job["run_attempt"] = 2
        self.change_source("docs/guide.md")
        self.assertEqual(self.collect(scope="desktop")["status"], "passed")
        for job in self.jobs:
            job["run_attempt"] = 2
        with self.assertRaisesRegex(ValueError, "another source/run/attempt"):
            self.collect(scope="desktop")
        self.input_summary["run_attempt"] = 2
        self.input_archive()
        self.assertEqual(self.collect(scope="desktop")["status"], "passed")

    def desktop_fixture(self):
        self.jobs = [dict(self.jobs[0], id=i, name=name) for i, name in
                     enumerate(sorted(recorder.DESKTOP_JOBS | {"process-checks"}), 1)]
        files = [f"test/{i}_test.dart" for i in range(4)]
        self.summary = dict(schema=1, kind="desktop-vm-ci", status="passed",
                            source=dict(commit=self.sha, tree=self.git("rev-parse", "HEAD^{tree}"), dirty=False),
                            platforms=[dict(platform=name, files=4, passed=4, skipped=0, verified_files=files,
                                            shards=[dict(shard=i, files=1, verified_files=1, passed=1, skipped=0,
                                                         recovered_files=[], receipt_sha256="a" * 64) for i in range(1, 5)])
                                       for name in sorted(recorder.DESKTOP_PLATFORMS)])
        self.desktop_archive()

    def desktop_archive(self):
        self.archive = self.zip_summary(self.summary, "desktop-test-summary.json")
        self.artifact.update(name="desktop-test-summary", size_in_bytes=len(self.archive),
                             digest="sha256:" + hashlib.sha256(self.archive).hexdigest())

    def test_desktop_scope_verifies_both_platforms_and_preserves_the_artifact(self):
        self.desktop_fixture()
        result = self.collect(scope="desktop", with_pr=True)
        self.assertEqual(result["status"], "passed")
        self.assertEqual(len(result["desktop_summary"]["platforms"]), 2)
        self.assertIn("Desktop VM `macos-15`", recorder.markdown(result))
        self.assertEqual((self.output / "desktop-test-summary.zip").read_bytes(), self.archive)
        self.assertNotIn("cli_summary", result)

    def test_desktop_missing_platform_bad_counts_and_wrong_tree_are_rejected(self):
        self.desktop_fixture()
        original = copy.deepcopy(self.summary)
        for change in [lambda s: s["platforms"].pop(),
                       lambda s: s["source"].update(tree="b" * 40),
                       lambda s: s["platforms"][0].update(passed=True),
                       lambda s: s["platforms"][0]["shards"].pop(),
                       lambda s: s["platforms"][0]["shards"][0].update(verified_files=0),
                       lambda s: s["platforms"][0]["shards"][0].update(recovered_files=["test/absent_test.dart"])]:
            self.summary = copy.deepcopy(original)
            change(self.summary)
            self.desktop_archive()
            with self.assertRaises(ValueError):
                self.collect(scope="desktop")

    def test_desktop_recovery_is_explicit_and_every_matrix_job_is_required(self):
        self.desktop_fixture()
        self.summary["platforms"][0]["shards"][0]["recovered_files"] = ["test/0_test.dart"]
        self.desktop_archive()
        self.assertIn("1 explicitly recorded pre-test loader recoveries", recorder.markdown(self.collect(scope="desktop")))
        self.jobs.pop()
        with self.assertRaisesRegex(ValueError, "missing jobs"):
            self.collect(scope="desktop")

    def test_full_scope_requires_and_retains_cli_and_desktop_summaries(self):
        cli_archive, cli_artifact = self.archive, copy.deepcopy(self.artifact)
        self.desktop_fixture()
        self.artifact["id"] = 988
        self.artifacts = [cli_artifact, self.artifact]
        self.archives = {"repos/owner/repo/actions/artifacts/987/zip": cli_archive,
                         "repos/owner/repo/actions/artifacts/988/zip": self.archive}
        self.jobs = [dict(self.jobs[0], id=i, name=name) for i, name in
                     enumerate(sorted(recorder.SCOPES["full"] | {"process-checks"}), 1)]
        result = self.collect(scope="full")
        self.assertEqual(result["status"], "passed")
        self.assertIn("cli_summary", result)
        self.assertIn("desktop_summary", result)
        self.assertEqual(result["artifact"]["id"], 987)
        self.assertEqual(result["desktop_artifact"]["id"], 988)
        optional = next(job for job in self.jobs if job["name"] == "companion-subsystems")
        optional["conclusion"] = "skipped"
        with self.assertRaisesRegex(ValueError, "required job was skipped: companion-subsystems"):
            self.collect(scope="full")
        optional["conclusion"] = "success"
        self.artifacts.pop()
        with self.assertRaisesRegex(ValueError, "Desktop coverage summary"):
            self.collect(scope="full")

    def test_partial_scope_cannot_be_called_full_ci(self):
        with self.assertRaisesRegex(ValueError, "missing jobs"):
            self.collect(scope="full")

    def test_missing_skipped_failed_or_wrong_source_job_is_rejected(self):
        original = copy.deepcopy(self.jobs)
        for change in [lambda: self.jobs.pop(), lambda: self.jobs[0].update(conclusion="skipped"),
                       lambda: self.jobs[0].update(conclusion="failure"), lambda: self.jobs[0].update(head_sha="b" * 40),
                       lambda: self.jobs.append(self.jobs[0])]:
            self.jobs = copy.deepcopy(original)
            change()
            with self.assertRaises(ValueError):
                self.collect()

    def test_pending_failed_or_wrong_workflow_run_is_not_success(self):
        original = dict(self.run)
        for change in [dict(status="in_progress"), dict(conclusion="failure"), dict(path=".github/workflows/other.yml"),
                       dict(repository={"full_name": "another/repo"}), dict(id=456)]:
            self.run = dict(original, **change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.collect()

    def test_continued_step_failure_cannot_hide_behind_a_green_job(self):
        self.jobs[0]["steps"] = [{"name": "tests", "conclusion": "failure"}]
        with self.assertRaisesRegex(ValueError, "failed or unfinished step"):
            self.collect()

    def test_corrupt_expired_or_mismatched_artifact_is_rejected(self):
        original = copy.deepcopy(self.artifact)
        for change in [dict(expired=True), dict(digest="sha256:" + "0" * 64), dict(workflow_run={"id": 456, "head_sha": self.sha})]:
            self.artifact = dict(original, **change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.collect()

    def test_archive_paths_are_never_extracted(self):
        self.archive = self.zip_summary(self.summary, "../escaped.json")
        self.artifact.update(digest="sha256:" + hashlib.sha256(self.archive).hexdigest())
        with self.assertRaisesRegex(ValueError, "contents"):
            self.collect()
        self.assertFalse((self.output.parent / "escaped.json").exists())

    def test_duplicate_or_inconsistent_coverage_is_rejected(self):
        for bad in [dict(self.summary, files=5), dict(self.summary, passed=True),
                    dict(self.summary, verified_files=["same"] * 4), dict(self.summary, shards=self.summary["shards"][:3])]:
            archive = self.zip_summary(bad)
            artifact = dict(self.artifact, digest="sha256:" + hashlib.sha256(archive).hexdigest())
            with self.assertRaises(ValueError):
                recorder.read_cli_summary(artifact, archive, self.run)

    def test_source_changes_and_dirty_working_copy_require_review(self):
        (self.root / "source.txt").write_text("different\n")
        result = self.collect()
        self.assertEqual(result["status"], "source_review_required")
        self.assertTrue(result["source"]["working_tree_dirty"])
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "changed")
        result = self.collect()
        self.assertEqual(result["status"], "source_review_required")
        self.assertEqual(result["source"]["changed_files"], ["source.txt"])
        historical = self.collect(target=self.sha)
        self.assertEqual(historical["status"], "passed")
        self.assertIn("historical commit", recorder.markdown(historical))

    def test_same_tree_with_different_commit_keeps_valid_evidence(self):
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "same tree")
        result = self.collect()
        self.assertEqual(result["status"], "passed")
        self.assertNotEqual(result["source"]["tested_sha"], result["source"]["target_sha"])
        self.assertTrue(result["source"]["same_tree"])

    def test_rerun_or_pr_movement_during_collection_is_rejected(self):
        self.after = dict(self.run, run_attempt=2)
        with self.assertRaisesRegex(ValueError, "run changed"):
            self.collect()
        self.after = None
        for part in ["head", "base"]:
            after = copy.deepcopy(self.pr)
            after[part]["sha"] = "b" * 40
            with self.assertRaisesRegex(ValueError, "PR head/base changed"):
                self.collect(with_pr=True, pr_after=after)

    def test_waited_attempt_cannot_be_replaced_before_collection(self):
        self.assertEqual(self.collect(expected_run=self.run)["status"], "passed")
        for change in [dict(run_attempt=2), dict(head_sha="b" * 40), dict(id=124)]:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "between waiting"):
                self.collect(expected_run=dict(self.run, **change))

    def test_stable_pr_pointing_elsewhere_needs_source_review(self):
        self.pr["head"]["sha"] = "b" * 40
        result = self.collect(with_pr=True)
        self.assertEqual(result["status"], "source_review_required")
        self.assertIn("PR head", recorder.markdown(result))

    def test_pagination_keeps_all_jobs_and_rejects_truncation(self):
        client = recorder.Client("owner/repo", 0)
        calls = []

        def api(path):
            calls.append(path)
            return {"total_count": 101, "jobs": list(range(100)) if path.endswith("&page=1") else [100]}

        client.api = api
        self.assertEqual(client.pages("jobs?filter=latest", "jobs"), list(range(101)))
        self.assertEqual(len(calls), 2)
        client.api = lambda _: {"total_count": 1, "jobs": []}
        with self.assertRaisesRegex(ValueError, "incomplete pagination"):
            client.pages("jobs", "jobs")


class WaitTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.run = dict(id=123, repository=dict(full_name="owner/repo"), path=".github/workflows/ci.yml",
                        head_sha="a" * 40, run_attempt=1, status="completed", conclusion="success")
        self.client = recorder.Client("owner/repo", 120)
        self.patch(recorder.time, "monotonic", side_effect=lambda: self.now)
        self.sleep = self.patch(recorder.time, "sleep", side_effect=self.advance)
        self.patch(recorder, "print", create=True)

    def patch(self, obj, name, **kwargs):
        patcher = mock.patch.object(obj, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def advance(self, seconds):
        self.now += seconds

    def observe(self, runs):
        self.client.api = mock.Mock(side_effect=runs)
        return recorder.wait_for_run(self.client, 123)

    def test_live_states_and_completed_fast_path_follow_one_run(self):
        for states in [[], ["queued", "pending", "waiting", "requested", "in_progress"]]:
            with self.subTest(states=states):
                self.now = 0
                self.sleep.reset_mock()
                result = self.observe([dict(self.run, status=s, conclusion=None) for s in states] + [self.run])
                self.assertEqual(result, self.run)
                self.assertEqual(self.sleep.call_count, len(states))
                self.assertTrue(all(call == mock.call("actions/runs/123") for call in self.client.api.call_args_list))

    def test_failed_or_cancelled_runs_stop_without_following_a_later_rerun(self):
        for conclusion in ["failure", "cancelled", "timed_out", "action_required", "skipped"]:
            with self.subTest(conclusion=conclusion), self.assertRaisesRegex(ValueError, "CI has not passed"):
                self.observe([dict(self.run, conclusion=conclusion), dict(self.run, run_attempt=2)])
            self.assertEqual(self.client.api.call_count, 1)
        self.sleep.assert_not_called()

    def test_identity_changes_and_unknown_states_fail_closed(self):
        for change in [dict(id=124), dict(repository=dict(full_name="other/repo")), dict(path="other.yml"),
                       dict(head_sha="b" * 40), dict(run_attempt=2), dict(status="unknown")]:
            self.now = 0
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe([dict(self.run, status="queued", conclusion=None), dict(self.run, **change)])

    def test_wait_deadline_does_not_restart_or_cancel_the_job(self):
        self.client.deadline = 12
        pending = dict(self.run, status="in_progress", conclusion=None)
        with self.assertRaisesRegex(TimeoutError, "follow the same run 123"):
            self.observe([pending, pending])
        self.assertEqual(self.now, 12)
        self.assertEqual(self.sleep.call_args_list, [mock.call(10), mock.call(2)])
        self.assertEqual(self.client.api.call_count, 2)

    def test_cli_keeps_waiting_and_collection_budgets_and_receipts_separate(self):
        with tempfile.TemporaryDirectory() as folder:
            root, output = Path(folder), Path(folder) / "evidence"
            self.patch(recorder.subprocess, "check_output", return_value=str(root))
            self.patch(recorder, "markdown", return_value="verified\n")

            def wait(client, run_id):
                self.assertEqual((client.deadline, run_id), (120, 123))
                self.advance(40)
                return self.run

            def collect(client, *args, expected_run=None):
                self.assertEqual(client.deadline, 130)  # A fresh 90s after waiting 40s.
                self.assertEqual(expected_run, self.run)
                self.advance(5)
                return dict(status="passed")

            self.patch(recorder, "wait_for_run", side_effect=wait)
            self.patch(recorder, "collect", side_effect=collect)
            result = recorder.main(["123", "--repo", "owner/repo", "--scope", "process", "--wait",
                                    "--wait-timeout", "120", "--output", str(output)])
            receipt = json.loads((output / "receipt.json").read_text())
            self.assertEqual(result, 0)
            self.assertEqual(receipt["waiting"]["duration_seconds"], 40)
            self.assertEqual(receipt["waiting"]["head_sha"], self.run["head_sha"])
            self.assertEqual(receipt["collection"]["duration_seconds"], 5)

    def test_cli_preserves_wait_failure_without_attempting_collection(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "evidence"
            self.patch(recorder.subprocess, "check_output", return_value=folder)
            self.patch(recorder, "wait_for_run", side_effect=TimeoutError("CI wait deadline exceeded"))
            collect = self.patch(recorder, "collect")
            result = recorder.main(["123", "--scope", "process", "--wait", "--output", str(output)])
            receipt = json.loads((output / "receipt.json").read_text())
            self.assertEqual(result, 1)
            self.assertIn("waiting", receipt)
            self.assertNotIn("collection", receipt)
            self.assertIn("CI wait deadline", receipt["error"])
            collect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
