#!/usr/bin/env python3
"""Enqueue an already-reviewed PR and retain evidence for its actual merged tree.

The exact reviewed head is bound to GitHub's enqueue mutation. Main may advance;
the required merge-group CI tests that combined candidate. No mutation is retried
after an uncertain response, and this command never publishes a release.
"""
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import time

spec = importlib.util.spec_from_file_location("queue_ci_evidence", Path(__file__).with_name("record-ci-validation.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

STATE_QUERY = """query($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) {
    id number state isDraft headRefOid baseRefName mergedAt
    mergeCommit { oid tree { oid } }
    mergeQueueEntry { id state position enqueuedAt headCommit { oid tree { oid } } }
  } }
}"""
ENQUEUE = """mutation($id:ID!,$head:GitObjectID!) {
  enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$head,jump:false}) {
    mergeQueueEntry { id }
  }
}"""


def graphql(client, query, **variables):
    args = ["api", "graphql", "-f", "query=" + query]
    for key, value in variables.items():
        args += ["-F" if isinstance(value, int) else "-f", f"{key}={value}"]
    result = client.command(*args)
    if result.get("errors") or not isinstance(result.get("data"), dict):
        raise ValueError("GitHub queue lookup failed: " + json.dumps(result.get("errors", [])))
    return result["data"]


def state(client, number, head, branch):
    owner, name = client.repository.split("/")
    pr = graphql(client, STATE_QUERY, owner=owner, name=name, number=number)["repository"]["pullRequest"]
    if (pr.get("number") != number or pr.get("headRefOid") != head or pr.get("baseRefName") != branch
            or pr.get("isDraft") is not False):
        raise ValueError("PR head, target or draft state differs from the reviewed source")
    return pr


def gate_evidence(client, run, output):
    ci.check_run(run, client.repository, run["id"])
    if run.get("event") not in {"pull_request", "merge_group"}:
        raise ValueError("only automatic PR or merge-group CI can authorize queued integration")
    jobs = client.pages(f"actions/runs/{run['id']}/jobs?filter=latest", "jobs")
    gates = [j for j in jobs if j["name"] == "ci/required"]
    if (len(gates) != 1 or gates[0].get("head_sha") != run["head_sha"]
            or gates[0].get("status") != "completed" or gates[0].get("conclusion") != "success"):
        raise ValueError("automatic required CI gate did not pass")
    artifacts = client.pages(f"actions/runs/{run['id']}/artifacts", "artifacts")
    matches = [a for a in artifacts if a.get("name") == "ci-required"]
    if len(matches) != 1 or matches[0].get("size_in_bytes", 65537) > 65536:
        raise ValueError("expected one bounded required-gate receipt")
    artifact = matches[0]
    archive = client.command("api", f"repos/{client.repository}/actions/artifacts/{artifact['id']}/zip", binary=True)
    receipt = ci.summary_contents(artifact, archive, run, "ci-required")
    commit = client.api(f"git/commits/{run['head_sha']}")
    if (commit.get("sha") != run["head_sha"] or receipt.get("schema") != 1
            or receipt.get("kind") != "ci-required" or receipt.get("status") != "passed"
            or receipt.get("source_sha") != run["head_sha"] or receipt.get("event") != run["event"]
            or receipt.get("source_tree") != commit.get("tree", {}).get("sha")
            or receipt.get("run_id") != run["id"] or receipt.get("run_attempt") != gates[0].get("run_attempt")
            or not receipt.get("required_jobs")
            or any(receipt.get("results", {}).get(job) != "success" for job in receipt["required_jobs"])
            or receipt.get("results", {}).get("plan") != "success"):
        raise ValueError("required-gate receipt has inconsistent source, coverage or run identity")
    after = client.api(f"actions/runs/{run['id']}")
    ci.check_run(after, client.repository, run["id"])
    if any(after[key] != run[key] for key in ["head_sha", "run_attempt", "updated_at"]):
        raise ValueError("CI changed during queue evidence collection")
    output.mkdir(parents=True, exist_ok=True)
    (output / "ci-required.zip").write_bytes(archive)
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return dict(run_id=run["id"], run_attempt=run["run_attempt"], url=run["html_url"],
                source_sha=receipt["source_sha"], source_tree=receipt["source_tree"],
                suites=receipt["suites"], artifact_id=artifact["id"], artifact_digest=artifact["digest"])


def pr_run(client, head):
    runs = client.pages("actions/workflows/ci.yml/runs?event=pull_request&head_sha=" + head, "workflow_runs")
    candidates = sorted((r for r in runs if r.get("head_sha") == head and r.get("event") == "pull_request"),
                        key=lambda r: r["id"], reverse=True)
    if not candidates:
        raise ValueError("automatic CI has not run for the reviewed PR head")
    return candidates[0]


def pr_gate(client, head, output):
    return gate_evidence(client, pr_run(client, head), output)


def merged_gate(client, tree, branch, started_at, output):
    # A merge may finish between polls, so don't depend on having seen its queue
    # ref. Search the automatic candidate runs and verify the immutable tree.
    path = "actions/workflows/ci.yml/runs?event=merge_group&created=%3E%3D" + started_at[:19] + "Z"
    runs = client.pages(path, "workflow_runs")
    candidates = sorted(runs, key=lambda r: r["id"], reverse=True)
    for run in candidates:
        if (run.get("status") != "completed" or run.get("conclusion") != "success"
                or not run.get("head_branch", "").startswith(f"gh-readonly-queue/{branch}/")):
            continue
        commit = client.api(f"git/commits/{run['head_sha']}")
        if commit.get("sha") == run["head_sha"] and commit.get("tree", {}).get("sha") == tree:
            return gate_evidence(client, run, output)
    raise ValueError("merged tree lacks verified successful merge-group CI; inspect this same PR")


def finish(client, root, number, head, base, output, *, merge=False, wait_timeout=1800, timeout=90, branch="main"):
    output.mkdir(parents=True, exist_ok=False)
    record = dict(schema=1, kind="queued-pr-merge", repository=client.repository, pr=number,
                  reviewed_head=head, reviewed_base=base, target_branch=branch, merge_authorized=merge,
                  started_at=ci.utc_now(), status="not_queued", phases={})

    def save():
        temporary = output / "receipt.tmp"
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(output / "receipt.json")

    def phase(name, action):
        started = time.monotonic()
        detail = record["phases"][name] = dict(started_at=ci.utc_now())
        save()
        try:
            return action()
        finally:
            detail.update(finished_at=ci.utc_now(), duration_seconds=round(time.monotonic() - started, 3))
            save()

    try:
        client.deadline = time.monotonic() + timeout
        local = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True, timeout=15).strip()
        dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=normal"], cwd=root, text=True, timeout=15).strip()
        if local != head or dirty:
            raise ValueError("the local checkout must remain clean at the reviewed head")
        subprocess.run(["git", "merge-base", "--is-ancestor", base, head], cwd=root, check=True, timeout=15)
        pr = phase("preflight", lambda: state(client, number, head, branch))
        if pr["state"] != "OPEN":
            raise ValueError("PR is not open")
        record["pr_evidence"] = phase("pr_validation", lambda: pr_gate(client, head, output / "pr-ci"))
        pr = state(client, number, head, branch)
        if pr["state"] != "OPEN":
            raise ValueError("PR state changed before enqueueing")
        entry = pr.get("mergeQueueEntry")
        # Resuming a queued PR must include the candidate created by its earlier
        # enqueue. A fresh command's start time would exclude that valid run.
        record["candidate_search_since"] = entry["enqueuedAt"] if entry else record["started_at"]
        if entry:
            record["queue_entry"] = entry
        record["status"] = "ready_for_queue"
        save()
        if merge:
            if not pr["mergeQueueEntry"]:
                record.update(status="enqueue_requested", enqueue_requested_at=ci.utc_now())
                save()
                try:
                    record["enqueue_response"] = phase("enqueue", lambda: graphql(client, ENQUEUE, id=pr["id"], head=head))
                except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                    record["enqueue_error"] = str(error)
            # Observe the same PR even after a lost enqueue response. Never
            # silently issue a second mutation or substitute a newer PR head.
            client.deadline = time.monotonic() + wait_timeout

            def follow():
                announced = None
                while time.monotonic() < client.deadline:
                    current = state(client, number, head, branch)
                    if current["state"] == "MERGED":
                        merged = current["mergeCommit"]
                        ci_sha = merged["oid"]
                        tree = merged["tree"]["oid"]
                        if not all(re.fullmatch(r"[0-9a-f]{40}", v or "") for v in [ci_sha, tree]):
                            raise ValueError("merged PR has an invalid commit/tree")
                        client.deadline = time.monotonic() + timeout
                        evidence = merged_gate(client, tree, branch, record["candidate_search_since"], output / "candidate-ci")
                        return dict(commit=ci_sha, tree=tree, merged_at=current["mergedAt"], evidence=evidence)
                    entry = current["mergeQueueEntry"]
                    if current["state"] != "OPEN" or not entry:
                        raise ValueError("PR left the merge queue or enqueue was not confirmed; inspect this same PR")
                    summary = (entry["id"], entry["state"], entry["position"])
                    if summary != announced:
                        print(f"PR #{number}: queue position {entry['position']}, {entry['state']}", flush=True)
                        announced = summary
                    record.update(status="queued", queue_entry=entry)
                    save()
                    time.sleep(min(10, max(0, client.deadline - time.monotonic())))
                raise TimeoutError("queue wait deadline exceeded; PR remains queued, follow the same PR")

            record["merge"] = phase("queue_wait_and_verification", follow)
            record["status"] = "merged"
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError, ci.zipfile.BadZipFile) as error:
        record["error"] = str(error)
        if "enqueue_requested_at" in record or record.get("queue_entry"):
            record["status"] = "queue_outcome_not_confirmed"
    record["finished_at"] = ci.utc_now()
    save()
    text = f"PR #{number}: **{record['status']}**.\nReviewed head `{head}`; review base `{base}`.\n"
    if "merge" in record:
        evidence = record["merge"]["evidence"]
        text += f"Merged `{record['merge']['commit']}`; its full tree matches verified [candidate CI]({evidence['url']}).\n"
    if "error" in record:
        text += record["error"] + "\n"
    (output / "merge.md").write_text(text)
    return record
