import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("merge_pr", Path(__file__).resolve().parents[1] / "merge-validated-pr.py")
merger = importlib.util.module_from_spec(spec)
spec.loader.exec_module(merger)


class MergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "source"
        self.root.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.test")
        (self.root / "source.txt").write_text("base\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD")
        (self.root / "source.txt").write_text("reviewed\n")
        self.git("commit", "-qam", "reviewed")
        self.head = self.git("rev-parse", "HEAD")
        self.tree = self.git("rev-parse", "HEAD^{tree}")
        self.output = Path(self.tmp.name) / "result"
        self.client = FakeClient(self)
        self.patch(merger.ci, "print", create=True)
        self.patch(merger.time, "sleep")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def patch(self, obj, name, **kwargs):
        patcher = mock.patch.object(obj, name, **kwargs)
        value = patcher.start()
        self.addCleanup(patcher.stop)
        return value

    def finish(self, merge=True):
        result = merger.finish(self.client, self.root, 5, 123, "process", self.head, self.base,
                               self.output, merge=merge)
        self.assertEqual(json.loads((self.output / "receipt.json").read_text()), result)
        return result

    def test_preview_verifies_full_evidence_without_mutating_github(self):
        result = self.finish(merge=False)
        self.assertEqual(result["status"], "ready")
        self.assertFalse(result["merge_authorized"])
        self.assertEqual(self.client.writes, [])
        self.assertTrue((self.output / "ci/validation.md").is_file())
        self.assertEqual(result["reviewed_source"]["tree"], self.tree)

    def test_merge_sends_exact_head_once_and_verifies_actual_tree(self):
        result = self.finish()
        self.assertEqual(result["status"], "merged")
        self.assertTrue(result["merge"]["same_tested_tree"])
        self.assertEqual(result["merge"]["commit"], self.client.merged_sha)
        self.assertEqual(self.client.writes, [("api", "--method", "PUT", "repos/owner/repo/pulls/5/merge",
                                               "-f", f"sha={self.head}", "-f", "merge_method=squash")])
        self.assertIn("merge_request", result["phases"])
        self.assertIn("verification", result["phases"])

    def test_wrong_pr_draft_target_or_head_stops_before_ci_or_mutation(self):
        original = copy.deepcopy(self.client.pr)
        for change in [dict(number=6), dict(state="closed"), dict(draft=True), dict(merged=True),
                       dict(head=dict(sha="b" * 40)),
                       dict(base=dict(ref="other", repo=dict(full_name="owner/repo"))),
                       dict(base=dict(ref="main", repo=dict(full_name="other/repo")))]:
            self.client.pr = dict(original, **change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                merger.preflight(self.client, self.root, 5, self.head, self.base)
        self.assertEqual(self.client.writes, [])
        self.assertEqual(self.client.run_reads, 0)

    def test_live_main_movement_is_detected_even_when_pr_base_snapshot_is_stale(self):
        self.client.actual_base = self.head
        result = self.finish()
        self.assertEqual(result["status"], "not_merged")
        self.assertIn("main moved", result["error"])
        self.assertEqual(self.client.writes, [])

    def test_untracked_work_or_different_local_head_cannot_merge(self):
        (self.root / "unreviewed.txt").write_text("change\n")
        with self.assertRaisesRegex(ValueError, "local checkout"):
            merger.preflight(self.client, self.root, 5, self.head, self.base)
        (self.root / "unreviewed.txt").unlink()
        self.git("commit", "--allow-empty", "-qm", "later")
        with self.assertRaisesRegex(ValueError, "local checkout"):
            merger.preflight(self.client, self.root, 5, self.head, self.base)

    def test_reviewed_head_must_include_reviewed_main(self):
        unrelated = self.git("commit-tree", self.tree, "-m", "unrelated")
        self.base = self.client.actual_base = unrelated
        result = self.finish()
        self.assertEqual(result["status"], "not_merged")
        self.assertEqual(self.client.writes, [])

    def test_failed_ci_and_missing_required_jobs_block_merge(self):
        self.client.run["conclusion"] = "failure"
        result = self.finish()
        self.assertEqual(result["status"], "not_merged")
        self.assertEqual(self.client.writes, [])
        self.output = self.output.with_name("missing-job")
        self.client.run["conclusion"] = "success"
        self.client.jobs = []
        result = self.finish()
        self.assertIn("missing jobs", result["error"])
        self.assertEqual(self.client.writes, [])

    def test_ci_for_a_different_tree_is_retained_but_cannot_merge(self):
        self.client.run["head_sha"] = self.base
        self.client.jobs[0]["head_sha"] = self.base
        result = self.finish()
        self.assertEqual(result["status"], "not_merged")
        self.assertEqual(self.client.writes, [])
        evidence = json.loads((self.output / "ci/receipt.json").read_text())
        self.assertEqual(evidence["status"], "source_review_required")

    def test_movement_after_ci_verification_is_rechecked_before_write(self):
        original = merger.preflight

        def moved(*args, **kwargs):
            if kwargs.get("ready"):
                self.client.actual_base = self.head
            return original(*args, **kwargs)

        self.patch(merger, "preflight", side_effect=moved)
        result = self.finish()
        self.assertEqual(result["status"], "not_merged")
        self.assertIn("main moved", result["error"])
        self.assertEqual(self.client.writes, [])

    def test_unknown_or_blocked_github_mergeability_never_bypasses_rules(self):
        for state in ["unknown", "blocked", "unstable", "dirty"]:
            self.output = Path(self.tmp.name) / state
            self.client.pr["mergeable_state"] = state
            result = self.finish()
            self.assertEqual(result["status"], "not_merged")
        self.assertEqual(self.client.writes, [])

    def test_lost_merge_response_is_resolved_by_reading_the_same_pr(self):
        self.client.behavior = "timeout_after_merge"
        result = self.finish()
        self.assertEqual(result["status"], "merged")
        self.assertIn("merge_request_error", result)
        self.assertEqual(len(self.client.writes), 1)

    def test_unconfirmed_request_is_retained_and_never_submitted_twice(self):
        self.client.behavior = "timeout_before_merge"
        result = self.finish()
        self.assertEqual(result["status"], "merge_not_confirmed")
        self.assertIn("inspect this same PR", result["error"])
        self.assertIn("merge_requested_at", result)
        self.assertEqual(len(self.client.writes), 1)

    def test_different_merged_tree_requires_review_instead_of_false_success(self):
        self.client.merged_tree = self.git("rev-parse", f"{self.base}^{{tree}}")
        result = self.finish()
        self.assertEqual(result["status"], "merged_source_review_required")
        self.assertFalse(result["merge"]["same_tested_tree"])
        self.assertEqual(len(self.client.writes), 1)

    def test_changed_head_or_target_during_write_cannot_claim_tested_merge(self):
        for behavior in ["retarget_during_merge", "head_change_during_merge", "wrong_response_sha"]:
            with self.subTest(behavior=behavior):
                self.output = Path(self.tmp.name) / behavior
                self.client = FakeClient(self)
                self.client.behavior = behavior
                result = self.finish()
                self.assertEqual(result["status"], "merge_not_confirmed")
                self.assertEqual(len(self.client.writes), 1)

    def test_bad_artifact_stops_before_merge_and_preserves_failure_receipt(self):
        self.patch(merger.ci, "collect", side_effect=merger.ci.zipfile.BadZipFile("bad artifact"))
        result = self.finish()
        self.assertEqual(result["status"], "not_merged")
        self.assertEqual(result["error"], "bad artifact")
        self.assertEqual(self.client.writes, [])


class FakeClient:
    repository = "owner/repo"

    def __init__(self, fixture):
        self.fixture, self.actual_base = fixture, fixture.base
        self.deadline, self.run_reads = 0, 0
        self.writes, self.behavior = [], "success"
        self.merged_sha, self.merged_tree = "c" * 40, fixture.tree
        self.pr = dict(number=5, state="open", draft=False, merged=False, mergeable=True, mergeable_state="clean",
                       html_url="https://github.com/owner/repo/pull/5", head=dict(sha=fixture.head),
                       base=dict(sha=fixture.base, ref="main", repo=dict(full_name=self.repository)))
        self.run = dict(id=123, repository=dict(full_name=self.repository), path=".github/workflows/ci.yml",
                        head_sha=fixture.head, run_attempt=1, status="completed", conclusion="success",
                        html_url="https://github.com/owner/repo/actions/runs/123",
                        created_at="2026-10-03T00:00:00Z", updated_at="2026-10-03T00:01:00Z")
        self.jobs = [dict(id=1, name="process-checks", run_id=123, run_attempt=1, head_sha=fixture.head,
                          status="completed", conclusion="success", steps=[],
                          started_at="2026-10-03T00:00:01Z", completed_at="2026-10-03T00:01:00Z")]

    def api(self, path):
        if path == "pulls/5":
            return copy.deepcopy(self.pr)
        if path == "git/ref/heads/main":
            return dict(ref="refs/heads/main", object=dict(type="commit", sha=self.actual_base))
        if path == "actions/runs/123":
            self.run_reads += 1
            return copy.deepcopy(self.run)
        if path == f"git/commits/{self.merged_sha}":
            return dict(sha=self.merged_sha, tree=dict(sha=self.merged_tree), parents=[dict(sha=self.actual_base)])
        raise AssertionError(path)

    def pages(self, path, key):
        assert key == "jobs", key
        return copy.deepcopy(self.jobs)

    def command(self, *args, binary=False):
        self.writes.append(args)
        before = json.loads((self.fixture.output / "receipt.json").read_text())
        assert before["status"] == "merge_requested" and before["reviewed_head"] == self.fixture.head
        if self.behavior == "timeout_before_merge":
            raise subprocess.TimeoutExpired("gh", 30)
        self.pr.update(merged=True, state="closed", merge_commit_sha=self.merged_sha,
                       merged_at="2026-10-03T00:01:10Z")
        if self.behavior == "timeout_after_merge":
            raise subprocess.TimeoutExpired("gh", 30)
        if self.behavior == "retarget_during_merge":
            self.pr["base"]["ref"] = "other"
        if self.behavior == "head_change_during_merge":
            self.pr["head"]["sha"] = "b" * 40
        return dict(sha="f" * 40 if self.behavior == "wrong_response_sha" else self.merged_sha, merged=True, message="merged")


if __name__ == "__main__":
    unittest.main()
