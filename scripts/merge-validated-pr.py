#!/usr/bin/env python3
"""Wait for required CI, then preview or perform an already-reviewed squash merge.

The caller selects required checks and completes code/native review first.
Only --merge writes to GitHub; this command never publishes a product release.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location("ci_evidence", Path(__file__).with_name("record-ci-validation.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)

queue_spec = importlib.util.spec_from_file_location("queue_merge", Path(__file__).with_name("queue-validated-pr.py"))
queue = importlib.util.module_from_spec(queue_spec)
queue_spec.loader.exec_module(queue)


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE, timeout=15, text=True).strip()


def preflight(client, root, number, head, base, ready=False):
    pr = client.api(f"pulls/{number}")
    if (pr.get("number") != number or pr.get("state") != "open" or pr.get("draft") is not False
            or pr.get("merged") is not False or pr.get("head", {}).get("sha") != head
            or pr.get("base", {}).get("ref") != "main"
            or pr.get("base", {}).get("repo", {}).get("full_name", "").lower() != client.repository.lower()):
        raise ValueError("PR is not the open, reviewed head targeting this repository's main")
    # PR base.sha can lag a new main commit. Read the actual ref, not its snapshot.
    ref = client.api("git/ref/heads/main")
    if (ref.get("ref") != "refs/heads/main" or ref.get("object", {}).get("type") != "commit"
            or ref["object"].get("sha") != base):
        raise ValueError("main moved since review; inspect the new source before merging")
    if git(root, "rev-parse", "HEAD") != head or git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("the local checkout must remain clean at the reviewed head")
    git(root, "merge-base", "--is-ancestor", base, head)
    if ready and (pr.get("mergeable") is not True or pr.get("mergeable_state") != "clean"):
        raise ValueError("GitHub does not report this PR ready to merge; no rules are bypassed")
    return {"head": head, "base": base, "tree": git(root, "rev-parse", f"{head}^{{tree}}"),
            "url": pr["html_url"]}


def confirm_merge(client, number, head, expected_tree, response, tested_tree=None):
    # A successful write can outlive an HTTP timeout. Observe the same PR;
    # never submit the mutation twice or assume that a timeout rejected it.
    for attempt in range(5):
        pr = client.api(f"pulls/{number}")
        if pr.get("merged") is True:
            sha = pr.get("merge_commit_sha", "")
            if (pr.get("number") != number or pr.get("head", {}).get("sha") != head
                    or pr.get("base", {}).get("ref") != "main"
                    or pr.get("base", {}).get("repo", {}).get("full_name", "").lower() != client.repository.lower()
                    or not re.fullmatch(r"[0-9a-f]{40}", sha)):
                raise ValueError("merged PR identity differs from the reviewed source")
            if response and response.get("merged") is True and response.get("sha") != sha:
                raise ValueError("merge response and actual PR commit disagree")
            commit = client.api(f"git/commits/{sha}")
            if commit.get("sha") != sha:
                raise ValueError("merge commit lookup returned another source")
            tree = commit.get("tree", {}).get("sha")
            if not re.fullmatch(r"[0-9a-f]{40}", tree or ""):
                raise ValueError("merge commit is missing its source tree")
            return dict(commit=sha, tree=tree, same_reviewed_tree=tree == expected_tree,
                        same_tested_tree=tree == (tested_tree or expected_tree),
                        merged_at=pr.get("merged_at"), parents=[p["sha"] for p in commit.get("parents", [])])
        if pr.get("state") == "closed" or attempt == 4:
            break
        time.sleep(1)
    raise ValueError("merge outcome not confirmed; inspect this same PR before any further action")


def finish(client, root, number, run_id, scope, head, base, output, *, merge=False, wait_timeout=900, timeout=90):
    output.mkdir(parents=True, exist_ok=False)
    record = dict(schema=1, kind="validated-pr-merge", repository=client.repository,
                  pr=number, run_id=run_id, scope=scope, reviewed_head=head, reviewed_base=base,
                  merge_authorized=merge, started_at=ci.utc_now(), status="not_merged", phases={})
    evidence = None
    automatic = run_id is None and scope is None

    def save():
        temporary = output / "receipt.tmp"
        temporary.write_text(json.dumps(record, indent=2) + "\n")
        temporary.replace(output / "receipt.json")

    def phase(name, action):
        started = time.monotonic()
        detail = record["phases"][name] = {"started_at": ci.utc_now()}
        save()
        try:
            return action()
        finally:
            detail.update(finished_at=ci.utc_now(), duration_seconds=round(time.monotonic() - started, 3))
            save()

    try:
        client.deadline = time.monotonic() + timeout
        record["reviewed_source"] = phase("preflight", lambda: preflight(client, root, number, head, base))
        if automatic:
            run = phase("find_automatic_ci", lambda: queue.pr_run(client, head))
            record["run_id"] = run_id = run["id"]
        client.deadline = time.monotonic() + wait_timeout
        observed = phase("waiting", lambda: ci.wait_for_run(client, run_id))
        client.deadline = time.monotonic() + timeout
        evidence_dir = output / "ci"
        evidence_dir.mkdir()
        if automatic:
            evidence = phase("collection", lambda: queue.gate_evidence(client, observed, evidence_dir))
            record["pr_evidence"] = evidence
            if (evidence["source_sha"] != head
                    or evidence["source_tree"] != record["reviewed_source"]["tree"]):
                raise ValueError("automatic CI does not cover the reviewed source")
            latest = queue.pr_run(client, head)
            if latest["id"] != run_id or latest["run_attempt"] != observed["run_attempt"]:
                raise ValueError("automatic PR CI changed during verification; follow the latest run")
            tested_tree = evidence["source_tree"]
        else:
            evidence = phase("collection", lambda: ci.collect(client, root, run_id, scope, head,
                                                              evidence_dir, number, expected_run=observed))
            (evidence_dir / "receipt.json").write_text(json.dumps(evidence, indent=2) + "\n")
            (evidence_dir / "validation.md").write_text(ci.markdown(evidence))
            if evidence["status"] != "passed":
                raise ValueError("CI evidence requires source review; no merge requested")
            tested_tree = evidence["source"]["tested_tree"]
        if phase("final_source_check", lambda: preflight(client, root, number, head, base, ready=True)) != record["reviewed_source"]:
            raise ValueError("reviewed source changed before merge")
        record["status"] = "ready"
        save()
        if merge:
            record.update(status="merge_requested", merge_requested_at=ci.utc_now())
            save()  # Retain the exact intended mutation before sending it.
            response = None
            try:
                response = phase("merge_request", lambda: client.command(
                    "api", "--method", "PUT", f"repos/{client.repository}/pulls/{number}/merge",
                    "-f", f"sha={head}", "-f", "merge_method=squash"))
                record["merge_response"] = response
            except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
                record["merge_request_error"] = str(error)
            # Inspection gets a fresh bounded budget even if the write timed out.
            client.deadline = time.monotonic() + min(timeout, 30)
            record["merge"] = phase("verification", lambda: confirm_merge(
                client, number, head, record["reviewed_source"]["tree"], response, tested_tree=tested_tree))
            record["status"] = "merged" if record["merge"]["same_reviewed_tree"] else "merged_source_review_required"
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError, ci.zipfile.BadZipFile) as error:
        record["error"] = str(error)
        record["status"] = "merge_not_confirmed" if "merge_requested_at" in record else "not_merged"
    record["finished_at"] = ci.utc_now()
    save()
    lines = [f"PR #{number}: **{record['status']}**.",
             f"Reviewed head `{head}`; reviewed main `{base}`."]
    if "error" in record:
        lines.append(record["error"])
    if "merge" in record:
        result = record["merge"]
        lines.append(f"Merged commit `{result['commit']}`; reviewed target tree matches: `{result['same_reviewed_tree']}`; "
                     f"full tested tree matches: `{result['same_tested_tree']}`.")
    if evidence is not None:
        if automatic:
            lines += ["", f"Verified [automatic PR CI]({evidence['url']}) for `{evidence['source_sha']}`."]
        else:
            lines += ["", ci.markdown(evidence)]
    (output / "merge.md").write_text("\n".join(lines) + "\n")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr", type=int)
    parser.add_argument("--run", type=int, help="legacy manual-run evidence; normally follows automatic PR CI")
    parser.add_argument("--scope", choices=ci.SCOPES, help="required only with legacy --run")
    parser.add_argument("--queue", action="store_true", help="explicitly use an available merge queue; not required for ordinary merges")
    parser.add_argument("--base-branch", default="main", help="queue target; use a disposable branch for rollout trials")
    parser.add_argument("--reviewed-head", required=True, help="full commit SHA already reviewed, including required non-CI checks")
    parser.add_argument("--reviewed-base", required=True, help="full main SHA included in the reviewed head")
    parser.add_argument("--repo", default="autonomous-ai/openharness")
    parser.add_argument("--merge", action="store_true", help="perform the authorized squash merge after verification; default: preview only")
    parser.add_argument("--wait-timeout", type=float, default=900)
    parser.add_argument("--timeout", type=float, default=90, help="budget for preflight and, separately, post-CI operations")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if (args.pr < 1 or (args.run is not None and args.run < 1)
            or any(not re.fullmatch(r"[0-9a-f]{40}", sha) for sha in [args.reviewed_head, args.reviewed_base])
            or any(not 0 < value < float("inf") for value in [args.wait_timeout, args.timeout])
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", args.repo)
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_/-]*", args.base_branch)):
        parser.error("supply positive IDs/budgets, full reviewed SHAs, and a valid repository")
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel")).resolve()
    output = args.output or root / ".harness/validation" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-merge-{args.pr}")
    client = ci.Client(args.repo, time.monotonic() + args.timeout)
    # Ordinary merges use automatic PR CI directly. Respect an actual queue
    # rule without making queue setup a prerequisite for every repository.
    rules = client.api(f"rules/branches/{args.base_branch}")
    queued = args.queue or any(rule.get("type") == "merge_queue" for rule in rules)
    if queued:
        record = queue.finish(client, root, args.pr, args.reviewed_head, args.reviewed_base, output,
                              merge=args.merge, wait_timeout=args.wait_timeout, timeout=args.timeout, branch=args.base_branch)
    else:
        if (args.run is None) != (args.scope is None) or args.base_branch != "main":
            parser.error("direct merging targets main; supply --run and --scope together only for legacy manual evidence")
        record = finish(client, root, args.pr, args.run, args.scope, args.reviewed_head,
                        args.reviewed_base, output, merge=args.merge, wait_timeout=args.wait_timeout, timeout=args.timeout)
    print(f"{record['status']}: {output / 'merge.md'}")
    if "error" in record:
        print(record["error"], file=sys.stderr)
    return {"merged": 0, "ready": 0, "ready_for_queue": 0, "merged_source_review_required": 3}.get(record["status"], 1)


if __name__ == "__main__":
    sys.exit(main())
