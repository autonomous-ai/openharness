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

spec = importlib.util.spec_from_file_location("queue_merge", Path(__file__).resolve().parents[1] / "queue-validated-pr.py")
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "source"
        self.root.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.test")
        self.git("config", "user.name", "Fixture")
        (self.root / "README.md").write_text("base")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD")
        (self.root / "README.md").write_text("reviewed")
        self.git("commit", "-qam", "reviewed")
        self.head = self.git("rev-parse", "HEAD")
        self.output = Path(self.tmp.name) / "result"
        self.client = FakeClient(self)
        p = mock.patch.object(queue.time, "sleep")
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch("builtins.print")
        p.start()
        self.addCleanup(p.stop)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def finish(self, merge=True):
        result = queue.finish(self.client, self.root, 5, self.head, self.base, self.output, merge=merge)
        self.assertEqual(json.loads((self.output / "receipt.json").read_text()), result)
        return result

    def test_preview_collects_automatic_evidence_without_writes(self):
        self.assertEqual(self.finish(False)["status"], "ready_for_queue")
        self.assertEqual(self.client.writes, [])

    def test_enqueue_is_bound_to_reviewed_head_and_combined_tree_verified(self):
        result = self.finish()
        self.assertEqual(result["status"], "merged")
        self.assertEqual(result["merge"]["tree"], self.client.candidate_tree)
        self.assertNotEqual(result["merge"]["tree"], self.git("rev-parse", "HEAD^{tree}"))
        self.assertEqual(len(self.client.writes), 1)
        self.assertIn("head=" + self.head, self.client.writes[0])
        self.assertEqual(result["merge"]["evidence"]["run_id"], 124)

    def test_lost_enqueue_response_is_observed_without_retrying_mutation(self):
        self.client.lost_response = True
        result = self.finish()
        self.assertEqual(result["status"], "merged")
        self.assertIn("enqueue_error", result)
        self.assertEqual(len(self.client.writes), 1)

    def test_resuming_existing_queue_entry_verifies_earlier_candidate_without_reenqueue(self):
        entry = dict(id="entry", state="AWAITING_CHECKS", position=1, enqueuedAt="2026-10-06T20:00:00Z")
        opened = dict(state="OPEN", mergeQueueEntry=entry)
        merged = dict(state="MERGED", mergeCommit={"oid": self.client.merged,
                      "tree": {"oid": self.client.candidate_tree}}, mergedAt="2026-10-07T03:00:00Z")
        with mock.patch.object(queue, "state", side_effect=[opened, opened, merged]):
            result = self.finish()
        self.assertEqual(result["status"], "merged")
        self.assertEqual(self.client.writes, [])
        self.assertEqual(result["candidate_search_since"], entry["enqueuedAt"])
        self.assertTrue(any("created=%3E%3D2026-10-06T20:00:00Z" in path for path in self.client.read_paths))

    def test_unconfirmed_enqueue_or_queue_removal_cannot_report_success(self):
        self.client.drop = True
        result = self.finish()
        self.assertEqual(result["status"], "queue_outcome_not_confirmed")
        self.assertEqual(len(self.client.writes), 1)

    def test_failed_pr_ci_cannot_enqueue(self):
        self.client.runs[123]["conclusion"] = "failure"
        self.assertEqual(self.finish()["status"], "not_queued")
        self.assertEqual(self.client.writes, [])

    def test_head_change_after_write_is_detected(self):
        self.client.change_head = True
        result = self.finish()
        self.assertEqual(result["status"], "queue_outcome_not_confirmed")
        self.assertEqual(len(self.client.writes), 1)

    def test_failed_or_wrong_tree_candidate_cannot_verify_merge(self):
        for patch in [{"conclusion": "failure"}, {"head_branch": "another-branch"}, {"head_sha": "e" * 40}]:
            self.client = FakeClient(self)
            self.output = Path(self.tmp.name) / ("case-" + list(patch)[0])
            self.client.runs[124].update(patch)
            with self.subTest(patch=patch):
                result = self.finish()
                self.assertEqual(result["status"], "queue_outcome_not_confirmed")
                self.assertEqual(len(self.client.writes), 1)

    def test_receipt_tampering_wrong_attempt_or_incomplete_jobs_blocks_enqueue(self):
        for patch in [{"source_sha": "f" * 40}, {"run_attempt": 2}, {"source_tree": "e" * 40},
                      {"results": {"process-checks": "skipped", "plan": "success"}}, {"event": "workflow_dispatch"}]:
            self.client = FakeClient(self)
            self.client.receipt_patch = patch
            self.output = Path(self.tmp.name) / ("receipt-" + list(patch)[0])
            with self.subTest(patch=patch):
                self.assertEqual(self.finish()["status"], "not_queued")
                self.assertEqual(self.client.writes, [])

    def test_dirty_or_unreviewed_checkout_cannot_enqueue(self):
        (self.root / "unreviewed.txt").write_text("change")
        self.assertEqual(self.finish()["status"], "not_queued")
        self.assertEqual(self.client.writes, [])


class FakeClient:
    repository = "owner/repo"

    def __init__(self, fixture):
        self.fixture = fixture
        self.writes, self.enqueued, self.polls = [], False, 0
        self.read_paths = []
        self.drop = self.change_head = self.lost_response = False
        self.receipt_patch = {}
        self.candidate, self.candidate_tree, self.merged = "c" * 40, "d" * 40, "b" * 40
        self.runs = {run_id: dict(id=run_id, repository={"full_name": self.repository}, path=".github/workflows/ci.yml",
            status="completed", conclusion="success", run_attempt=1, updated_at="2026-10-07T03:00:00Z",
            head_sha=fixture.head if run_id == 123 else self.candidate,
            event="pull_request" if run_id == 123 else "merge_group", head_branch="topic" if run_id == 123 else "gh-readonly-queue/main/pr-5-head",
            html_url=f"https://github.com/owner/repo/actions/runs/{run_id}") for run_id in [123, 124]}

    def archive(self, run):
        receipt = dict(schema=1, kind="ci-required", status="passed", source_sha=run["head_sha"],
            source_tree=self.fixture.git("rev-parse", "HEAD^{tree}") if run["id"] == 123 else self.candidate_tree,
            event=run["event"], run_id=run["id"], run_attempt=1, suites=[], required_jobs=["process-checks"],
            results={"process-checks": "success", "plan": "success"})
        if run["id"] == 123:
            receipt.update(self.receipt_patch)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as bundle:
            bundle.writestr(zipfile.ZipInfo("ci-required.json", (2026, 10, 7, 0, 0, 0)), json.dumps(receipt))
        return stream.getvalue()

    def api(self, path):
        if path.startswith("actions/runs/"):
            return copy.deepcopy(self.runs[int(path.split("/")[2])])
        if path.startswith("git/commits/"):
            head = path.split("/")[-1]
            tree = self.fixture.git("rev-parse", "HEAD^{tree}") if head == self.fixture.head else self.candidate_tree
            if head == "e" * 40:
                tree = "f" * 40
            return dict(sha=head, tree={"sha": tree})
        raise AssertionError(path)

    def pages(self, path, key):
        self.read_paths.append(path)
        if key == "workflow_runs":
            return [copy.deepcopy(self.runs[123 if "event=pull_request" in path else 124])]
        run = self.runs[int(path.split("/")[2])]
        if key == "jobs":
            return [dict(name="ci/required", status="completed", conclusion="success", head_sha=run["head_sha"], run_attempt=1)]
        if key == "artifacts":
            archive = self.archive(run)
            return [dict(id=run["id"], name="ci-required", expired=False, size_in_bytes=len(archive),
                         digest="sha256:" + hashlib.sha256(archive).hexdigest(), workflow_run={"id":run["id"], "head_sha":run["head_sha"]})]
        raise AssertionError(path)

    def command(self, *args, binary=False):
        if binary:
            return self.archive(self.runs[int(args[-1].split("/")[-2])])
        query = next(v for v in args if v.startswith("query="))
        if "enqueuePullRequest" in query:
            self.writes.append(args)
            receipt = json.loads((self.fixture.output / "receipt.json").read_text())
            assert receipt["status"] == "enqueue_requested"
            self.enqueued = True
            if self.lost_response:
                raise subprocess.TimeoutExpired("gh", 30)
            return {"data":{"enqueuePullRequest":{"mergeQueueEntry":{"id":"entry"}}}}
        self.polls += int(self.enqueued)
        merged = self.enqueued and not self.drop
        pr = dict(id="pr", number=5, state="MERGED" if merged else "OPEN", isDraft=False,
                  headRefOid="f" * 40 if self.enqueued and self.change_head else self.fixture.head,
                  baseRefName="main", mergedAt="2026-10-07T03:00:00Z" if merged else None,
                  mergeCommit={"oid":self.merged,"tree":{"oid":self.candidate_tree}} if merged else None,
                  mergeQueueEntry=None)
        return {"data":{"repository":{"pullRequest":pr}}}


if __name__ == "__main__":
    unittest.main()
