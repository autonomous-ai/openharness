#!/usr/bin/env python3
"""Collect a completed CI run into JSON and a PR-ready validation paragraph.

Read-only GitHub access; this does not run checks, edit PRs, approve or merge code.
Exit 3 means the CI passed but source differences still require review.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import zipfile

CLI_JOBS = {"cli-contracts", "cli-coverage-gates", "typecheck-test"} | {f"cli-tests ({i})" for i in range(1, 5)} | {
    f"serial-native ({system}, {node})" for system in ["ubuntu-latest", "macos-latest"] for node in ["20.19.0", "22.23.2"]
} | {f"process-images-native ({system})" for system in ["macos-15", "macos-15-intel"]}
TUI_JOBS = {"tui-test (ubuntu-latest, x86_64-unknown-linux-musl)", "tui-test (ubuntu-24.04-arm, aarch64-unknown-linux-musl)"}
DESKTOP_PLATFORMS = {"ubuntu-22.04", "macos-15"}
DESKTOP_JOBS = {"desktop-test-summary"} | {f"desktop-tests ({platform}, {index})" for platform in DESKTOP_PLATFORMS for index in range(1, 5)}
SCOPES = {"cli": CLI_JOBS, "tui": TUI_JOBS, "backend": {"backend-desk"}, "desktop": DESKTOP_JOBS, "process": set()}
SCOPES["full"] = CLI_JOBS | TUI_JOBS | SCOPES["backend"] | DESKTOP_JOBS | {"companion-subsystems"}

# These are the source boundaries enforced by CI's sparse checkouts. Keep the
# whole workflow/action and helper trees: a changed test, toolchain pin, cache
# recipe or source contract must invalidate earlier evidence too.
SOURCE_INPUTS = {
    "process": (".github/", "scripts/", "desktop/scripts/", ".gitattributes", ".gitignore", ".gitmodules", "Makefile"),
    # VM tests also read CLI protocol definitions, shared layout fixtures,
    # daemon metadata and store catalog/artwork, including docs/images posters.
    "desktop": (".github/", "scripts/", "desktop/", "cli/", "tests/", "daemons/", "store/", "docs/images/",
                "mobile/pubspec.lock", ".gitattributes", ".gitignore", ".gitmodules", "Makefile"),
}
CHECKOUT_STEP = "Verify declared source checkout"


def input_snapshot(root, commit, scope):
    """Hash immutable Git objects, including missing optional files and modes."""
    objects = []
    for path in sorted(SOURCE_INPUTS[scope]):
        name = path.rstrip("/")
        data = subprocess.check_output(["git", "ls-tree", "-z", commit, "--", name],
                                       cwd=root, stderr=subprocess.PIPE, timeout=10).decode()
        entries = [entry for entry in data.split("\0") if entry]
        if not entries:
            if path.endswith("/"):
                raise ValueError(f"required CI input directory is missing: {path}")
            objects.append(dict(path=path, object=None))
            continue
        if len(entries) != 1:
            raise ValueError(f"ambiguous CI input: {path}")
        metadata, actual_path = entries[0].split("\t", 1)
        mode, kind, oid = metadata.split()
        if (actual_path != name or not re.fullmatch(r"[0-9a-f]{40}", oid)
                or (path.endswith("/") and (mode, kind) != ("040000", "tree"))
                or (not path.endswith("/") and (kind != "blob" or mode not in {"100644", "100755"}))):
            raise ValueError(f"unexpected CI input object: {path}")
        objects.append(dict(path=path, object=dict(mode=mode, kind=kind, oid=oid)))
    payload = dict(scope=scope, objects=objects)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return dict(payload, sha256=digest)


def check_input_jobs(jobs, scope):
    required = SCOPES[scope] | {"process-checks"}
    for job in jobs:
        if job["name"] in required:
            matches = [step for step in job.get("steps", []) if step.get("name") == CHECKOUT_STEP]
            if len(matches) != 1 or matches[0].get("conclusion") != "success":
                raise ValueError(f"CI input checkout was not verified: {job['name']}")


def read_input_summary(artifact, archive, run, root, scope, process_attempt):
    summary = summary_contents(artifact, archive, run, "ci-source-inputs")
    if (type(summary.get("schema")) is not int or summary["schema"] != 1
            or summary.get("kind") != "ci-source-inputs" or summary.get("status") != "recorded"
            or summary.get("source_sha") != run["head_sha"] or summary.get("dirty") is not False
            or not isinstance(summary.get("scopes"), dict)
            or type(summary.get("run_id")) is not int or summary["run_id"] != run["id"]
            or type(summary.get("run_attempt")) is not int or summary["run_attempt"] != process_attempt):
        raise ValueError("CI input receipt has another source/run/attempt")
    tree = subprocess.check_output(["git", "rev-parse", f"{run['head_sha']}^{{tree}}"],
                                   cwd=root, stderr=subprocess.PIPE, timeout=10).decode().strip()
    expected = input_snapshot(root, run["head_sha"], scope)
    if summary.get("source_tree") != tree or summary.get("scopes", {}).get(scope) != expected:
        raise ValueError("CI input receipt differs from the tested Git objects or input contract")
    return expected


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def seconds(start, end):
    value = (datetime.fromisoformat(end.replace("Z", "+00:00")) - datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds()
    if value < 0:
        raise ValueError("invalid CI timestamps")
    return round(value, 3)


class Client:
    def __init__(self, repository, deadline):
        self.repository, self.deadline = repository, deadline

    def command(self, *args, binary=False):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("evidence collection deadline exceeded")
        env = dict(os.environ, GH_PROMPT_DISABLED="1")
        env.pop("GH_DEBUG", None)
        result = subprocess.run(["gh", *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=min(30, remaining), env=env)
        if result.returncode:
            raise RuntimeError(f"GitHub lookup failed ({result.returncode}): {' '.join(args[:2])}")
        return result.stdout if binary else json.loads(result.stdout)

    def api(self, path):
        return self.command("api", f"repos/{self.repository}/{path}")

    def pages(self, path, key):
        values, page = [], 1
        separator = "&" if "?" in path else "?"
        while True:
            data = self.api(f"{path}{separator}per_page=100&page={page}")
            values.extend(data[key])
            if len(values) >= data["total_count"]:
                if len(values) != data["total_count"]:
                    raise ValueError(f"inconsistent pagination for {key}")
                return values
            if not data[key]:
                raise ValueError(f"incomplete pagination for {key}")
            page += 1


def check_run_identity(run, repository, run_id):
    if (run.get("id") != run_id or run.get("repository", {}).get("full_name", "").lower() != repository.lower()
            or run.get("path") != ".github/workflows/ci.yml" or not re.fullmatch(r"[0-9a-f]{40}", run.get("head_sha", ""))):
        raise ValueError("run repository, workflow or source does not match this CI request")
    if type(run.get("run_attempt")) is not int or run["run_attempt"] < 1:
        raise ValueError("run attempt is missing")


def check_run(run, repository, run_id):
    check_run_identity(run, repository, run_id)
    if run.get("status") != "completed" or run.get("conclusion") != "success":
        raise ValueError(f"CI has not passed: {run.get('status')}/{run.get('conclusion')}; follow the same run")


def wait_for_run(client, run_id):
    """Observe one immutable run attempt; never dispatch, cancel, or rerun it."""
    identity, previous_state, announced_at = None, None, 0
    while True:
        if time.monotonic() >= client.deadline:
            raise TimeoutError(f"CI wait deadline exceeded; follow the same run {run_id}")
        run = client.api(f"actions/runs/{run_id}")
        check_run_identity(run, client.repository, run_id)
        current = (run["head_sha"], run["run_attempt"])
        if identity is not None and current != identity:
            raise ValueError("CI run source/attempt changed while waiting")
        identity = current
        state = (run.get("status"), run.get("conclusion"))
        if state[0] not in {"queued", "requested", "waiting", "pending", "in_progress", "completed"}:
            raise ValueError(f"unexpected CI run status: {state[0]}")
        now = time.monotonic()
        if state != previous_state or now - announced_at >= 30:
            print(f"CI {run_id}, attempt {run['run_attempt']}: {state[0]}/{state[1] or 'pending'}", flush=True)
            previous_state, announced_at = state, now
        if state[0] == "completed":
            check_run(run, client.repository, run_id)
            return run
        time.sleep(min(10, max(0, client.deadline - now)))


def check_jobs(run, jobs, scope):
    names = [job["name"] for job in jobs]
    if len(names) != len(set(names)) or len({job["id"] for job in jobs}) != len(jobs):
        raise ValueError("duplicate CI jobs")
    required = SCOPES[scope] | {"process-checks"}
    missing = required - set(names)
    if missing:
        raise ValueError(f"requested {scope} scope is missing jobs: {', '.join(sorted(missing))}")
    for job in jobs:
        if (job.get("run_id") != run["id"] or job.get("head_sha") != run["head_sha"]
                or not 1 <= job.get("run_attempt", 0) <= run["run_attempt"]):
            raise ValueError(f"job belongs to a different run/source/attempt: {job['name']}")
        if job.get("status") != "completed" or job.get("conclusion") not in {"success", "skipped"}:
            raise ValueError(f"job did not pass: {job['name']}")
        if job["name"] in required and job["conclusion"] != "success":
            raise ValueError(f"required job was skipped: {job['name']}")
        if any(step.get("conclusion") not in {"success", "skipped"} for step in job.get("steps", [])):
            raise ValueError(f"job contains a failed or unfinished step: {job['name']}")


def summary_contents(artifact, archive, run, name):
    provenance = artifact.get("workflow_run", {})
    if (artifact.get("name") != name or artifact.get("expired") is not False
            or provenance.get("id") != run["id"] or provenance.get("head_sha") != run["head_sha"]):
        raise ValueError("summary artifact is expired or belongs to another source/run")
    digest = "sha256:" + hashlib.sha256(archive).hexdigest()
    if artifact.get("digest") != digest:
        raise ValueError("summary archive digest mismatch")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        if bundle.namelist() != [name + ".json"] or bundle.infolist()[0].file_size > 8 * 1024 ** 2:
            raise ValueError("unexpected summary archive contents")
        summary = json.loads(bundle.read(name + ".json"))
    if not isinstance(summary, dict):
        raise ValueError("invalid summary object")
    return summary


def read_cli_summary(artifact, archive, run):
    summary = summary_contents(artifact, archive, run, "cli-test-summary")
    for key in ["files", "passed", "skipped", "todo"]:
        if type(summary.get(key)) is not int or summary[key] < 0:
            raise ValueError("invalid CLI summary counts")
    files = summary.get("verified_files", [])
    shards = summary.get("shards", [])
    if (summary.get("schema") != 1 or summary.get("status") != "passed" or not summary["files"]
            or len(files) != summary["files"] or len(set(files)) != len(files)
            or len(shards) != 4 or {shard["shard"] for shard in shards} != {1, 2, 3, 4}
            or any(sum(shard[key] for shard in shards) != summary[key] for key in ["files", "passed", "skipped", "todo"])):
        raise ValueError("CLI summary coverage is incomplete or inconsistent")
    return summary


def read_desktop_summary(artifact, archive, run):
    summary = summary_contents(artifact, archive, run, "desktop-test-summary")
    source = summary.get("source", {})
    platforms = summary.get("platforms", [])
    if (summary.get("schema") != 1 or summary.get("kind") != "desktop-vm-ci" or summary.get("status") != "passed"
            or source.get("commit") != run["head_sha"] or source.get("dirty") is not False
            or not re.fullmatch(r"[0-9a-f]{40}", source.get("tree", ""))
            or not isinstance(platforms, list) or len(platforms) != len(DESKTOP_PLATFORMS)
            or {p.get("platform") for p in platforms} != DESKTOP_PLATFORMS):
        raise ValueError("Desktop summary source/platform coverage differs")
    inventory = None
    for platform in platforms:
        for key in ["files", "passed", "skipped"]:
            if type(platform.get(key)) is not int or platform[key] < 0:
                raise ValueError("invalid Desktop summary count")
        files, shards = platform.get("verified_files", []), platform.get("shards", [])
        if (not platform["files"] or len(files) != platform["files"] or len(set(files)) != len(files)
                or any(not isinstance(p, str) or not p.startswith("test/") or not p.endswith("_test.dart")
                       or ".." in p.split("/") or p.startswith("test/web/") for p in files)
                or len(shards) != 4 or {s["shard"] for s in shards} != {1, 2, 3, 4}):
            raise ValueError("Desktop summary file/shard coverage is incomplete")
        if inventory is not None and set(files) != inventory:
            raise ValueError("Desktop platform inventories disagree")
        inventory = set(files)
        for shard in shards:
            if (any(type(shard.get(k)) is not int or shard[k] < 0 for k in ["files", "verified_files", "passed", "skipped"])
                    or not shard["files"] or shard["verified_files"] != shard["files"]
                    or not re.fullmatch(r"[0-9a-f]{64}", shard.get("receipt_sha256", ""))
                    or not isinstance(shard.get("recovered_files"), list)
                    or len(set(shard["recovered_files"])) != len(shard["recovered_files"])
                    or not set(shard["recovered_files"]) <= inventory):
                raise ValueError("Desktop shard counts or recovery record differ")
        if any(sum(s[k] for s in shards) != platform[k] for k in ["files", "passed", "skipped"]):
            raise ValueError("Desktop summary totals disagree")
    return summary


def source_comparison(root, tested, target):
    def git(*args):
        return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE, timeout=10).decode().strip()
    target_sha = git("rev-parse", "--verify", "--end-of-options", f"{target}^{{commit}}")
    tested_tree, target_tree = (git("rev-parse", f"{sha}^{{tree}}") for sha in [tested, target_sha])
    paths = git("diff", "--name-only", "--no-renames", "-z", tested, target_sha, "--").split("\0")
    checkout = git("rev-parse", "HEAD")
    dirty = bool(git("status", "--porcelain", "--untracked-files=normal")) if target_sha == checkout else None
    return {"tested_sha": tested, "target_sha": target_sha, "tested_tree": tested_tree, "target_tree": target_tree,
            "same_tree": tested_tree == target_tree, "changed_files": list(filter(None, paths)), "working_tree_dirty": dirty, "checkout_head": checkout}


def collect(client, root, run_id, scope, target, output, pr_number=None, expected_run=None):
    run = client.api(f"actions/runs/{run_id}")
    check_run(run, client.repository, run_id)
    if expected_run is not None and any(run[key] != expected_run[key] for key in ["id", "head_sha", "run_attempt"]):
        raise ValueError("CI run changed between waiting and evidence collection")
    with ThreadPoolExecutor(max_workers=3) as pool:
        job_future = pool.submit(client.pages, f"actions/runs/{run_id}/jobs?filter=latest", "jobs")
        artifact_future = pool.submit(client.pages, f"actions/runs/{run_id}/artifacts", "artifacts") if scope in {"cli", "desktop", "full", "process"} else None
        pr_future = pool.submit(client.api, f"pulls/{pr_number}") if pr_number else None
        jobs = job_future.result()
        artifacts = artifact_future.result() if artifact_future else []
        pr = pr_future.result() if pr_future else None
    check_jobs(run, jobs, scope)
    source = source_comparison(root, run["head_sha"], target)
    record = {"schema": 1, "repository": client.repository, "scope": scope, "status": "passed",
              "run": {key: run[key] for key in ["id", "run_attempt", "head_sha", "html_url", "created_at", "updated_at", "status", "conclusion"]},
              "workflow_seconds": seconds(run["created_at"], run["updated_at"]), "source": source,
              "jobs": [{"id": job["id"], "name": job["name"], "attempt": job["run_attempt"], "conclusion": job["conclusion"],
                        "started_at": job["started_at"], "completed_at": job["completed_at"],
                        "seconds": seconds(job["started_at"], job["completed_at"]) if job["conclusion"] == "success" else None,
                        "steps": [{"name": step["name"], "conclusion": step["conclusion"]} for step in job.get("steps", [])]} for job in jobs]}
    if scope in {"cli", "full"}:
        matches = [artifact for artifact in artifacts if artifact["name"] == "cli-test-summary"]
        if len(matches) != 1:
            raise ValueError("expected one nonexpired CLI coverage summary artifact")
        artifact = matches[0]
        if artifact.get("size_in_bytes", 16 * 1024 ** 2 + 1) > 16 * 1024 ** 2:
            raise ValueError("CLI coverage artifact is unexpectedly large")
        archive = client.command("api", f"repos/{client.repository}/actions/artifacts/{artifact['id']}/zip", binary=True)
        record["cli_summary"] = read_cli_summary(artifact, archive, run)
        record["artifact"] = {key: artifact[key] for key in ["id", "name", "digest", "size_in_bytes"]}
        (output / "cli-test-summary.zip").write_bytes(archive)
    if scope in {"desktop", "full"}:
        matches = [artifact for artifact in artifacts if artifact["name"] == "desktop-test-summary"]
        if len(matches) != 1:
            raise ValueError("expected one nonexpired Desktop coverage summary artifact")
        artifact = matches[0]
        if artifact.get("size_in_bytes", 16 * 1024 ** 2 + 1) > 16 * 1024 ** 2:
            raise ValueError("Desktop coverage artifact is unexpectedly large")
        archive = client.command("api", f"repos/{client.repository}/actions/artifacts/{artifact['id']}/zip", binary=True)
        record["desktop_summary"] = read_desktop_summary(artifact, archive, run)
        if record["desktop_summary"]["source"]["tree"] != source["tested_tree"]:
            raise ValueError("Desktop summary Git tree differs from the tested source")
        record["desktop_artifact"] = {key: artifact[key] for key in ["id", "name", "digest", "size_in_bytes"]}
        (output / "desktop-test-summary.zip").write_bytes(archive)
    if scope in SOURCE_INPUTS:
        matches = [artifact for artifact in artifacts if artifact["name"] == "ci-source-inputs"]
        if len(matches) > 1:
            raise ValueError("duplicate CI input receipts")
        if matches:
            artifact = matches[0]
            if artifact.get("size_in_bytes", 65537) > 65536:
                raise ValueError("CI input artifact is unexpectedly large")
            archive = client.command("api", f"repos/{client.repository}/actions/artifacts/{artifact['id']}/zip", binary=True)
            check_input_jobs(jobs, scope)
            # Rerunning failed jobs can retain an earlier successful process job.
            # Bind the artifact to that job's actual attempt, not a later shard's.
            process_attempt = next(job["run_attempt"] for job in jobs if job["name"] == "process-checks")
            tested_inputs = read_input_summary(artifact, archive, run, root, scope, process_attempt)
            target_inputs = input_snapshot(root, source["target_sha"], scope)
            record["scope_reuse"] = dict(scope=scope, paths=sorted(SOURCE_INPUTS[scope]),
                                         tested_sha256=tested_inputs["sha256"], target_sha256=target_inputs["sha256"],
                                         same_inputs=tested_inputs == target_inputs)
            record["input_artifact"] = {key: artifact[key] for key in ["id", "name", "digest", "size_in_bytes"]}
            (output / "ci-source-inputs.zip").write_bytes(archive)
    if pr:
        record["pr"] = {"number": pr_number, "url": pr["html_url"], "head": pr["head"]["sha"], "base": pr["base"]["sha"]}
    # Detect reruns and moving PR heads after the independent downloads. Never
    # accidentally pair a new attempt/head with the old artifact or job verdicts.
    with ThreadPoolExecutor(max_workers=2) as pool:
        run_future = pool.submit(client.api, f"actions/runs/{run_id}")
        pr_future = pool.submit(client.api, f"pulls/{pr_number}") if pr else None
        after = run_future.result()
        pr_after = pr_future.result() if pr_future else None
    check_run(after, client.repository, run_id)
    if any(after[key] != run[key] for key in ["run_attempt", "head_sha", "updated_at"]):
        raise ValueError("CI run changed during collection; inspect the same run again")
    if pr and any(pr_after[key]["sha"] != pr[key]["sha"] for key in ["head", "base"]):
        raise ValueError("PR head/base changed during collection; review the new state")
    if source != source_comparison(root, run["head_sha"], target):
        raise ValueError("local source changed during collection")
    covered = source["same_tree"] or record.get("scope_reuse", {}).get("same_inputs") is True
    if not covered or source["working_tree_dirty"] or (pr and pr["head"]["sha"] != source["target_sha"]):
        record["status"] = "source_review_required"
    return record


def markdown(record):
    if record["status"] == "collection_failed":
        return f"CI evidence collection incomplete: {record['error']}\n"
    run, source = record["run"], record["source"]
    elapsed = int(record["workflow_seconds"])
    lines = [f"Required scope `{record['scope']}` verified: [CI run {run['id']}]({run['html_url']}) passed, attempt {run['run_attempt']}.",
             f"Elapsed **{elapsed // 60}m{elapsed % 60:02}s**, {run['created_at']} → {run['updated_at']} (CI time only).",
             f"Tested commit `{source['tested_sha']}`; target `{source['target_sha']}`."]
    if "cli_summary" in record:
        c = record["cli_summary"]
        lines.append(f"CLI default suite: **{c['files']} files verified exactly once; {c['passed']:,} passed, {c['skipped']} skipped, {c['todo']} todo**. Summary artifact digest verified.")
    if "desktop_summary" in record:
        for platform in record["desktop_summary"]["platforms"]:
            recovered = sum(len(s["recovered_files"]) for s in platform["shards"])
            recovery = f" Includes {recovered} explicitly recorded pre-test loader recoveries." if recovered else ""
            lines.append(f"Desktop VM `{platform['platform']}`: **{platform['files']} files verified exactly once; "
                         f"{platform['passed']:,} passed, {platform['skipped']} skipped**. Summary artifact digest verified.{recovery}")
    lines += ["", "| Job | Result | Time |", "| --- | --- | ---: |"]
    for job in record["jobs"]:
        name = job["name"].replace("|", "\\|").replace("\n", " ")
        elapsed = f"{job['seconds']:g}s" if job["seconds"] is not None else "—"
        lines.append(f"| {name} | {job['conclusion']} | {elapsed} |")
    lines.append("")
    if record["status"] == "source_review_required":
        lines.append("**Source review required before reusing this result.**")
        if not source["same_tree"]:
            lines.append("Changed paths since the tested commit: " + ", ".join(f"`{path.replace('`', '')}`" for path in source["changed_files"]) + ".")
        if source["working_tree_dirty"]:
            lines.append("The current working tree also contains changes outside this committed CI result.")
        if "pr" in record and record["pr"]["head"] != source["target_sha"]:
            lines.append(f"PR head `{record['pr']['head']}` differs from the selected target.")
    elif not source["same_tree"]:
        reuse = record["scope_reuse"]
        lines.append(f"CI evidence reused for `{record['scope']}`: the declared source inputs match "
                     f"(`{reuse['tested_sha256']}`). Receipt digest, Git objects and bounded checkouts verified.")
        lines.append("Changed paths outside that CI scope: " + ", ".join(f"`{path.replace('`', '')}`" for path in source["changed_files"]) + ".")
        lines.append("This covers the selected CI checks, not review or validation required by those other changes.")
    else:
        lines.append("The tested and target source trees match. Scope selection and code/merge review remain explicit.")
    if source["working_tree_dirty"] is None:
        lines.append("The selected target is a historical commit; this record does not cover the current working copy.")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=int)
    parser.add_argument("--repo", default="autonomous-ai/openharness")
    parser.add_argument("--scope", choices=SCOPES, required=True)
    parser.add_argument("--target", default="HEAD", help="committed source to compare with the tested tree")
    parser.add_argument("--pr", type=int, help="also verify that this PR still names the target commit")
    parser.add_argument("--output", type=Path, help="new evidence directory; defaults to ignored .harness/validation/")
    parser.add_argument("--timeout", type=float, default=90, help="evidence collection budget in seconds (default: 90)")
    parser.add_argument("--wait", action="store_true", help="follow this run attempt, then collect its completed evidence")
    parser.add_argument("--wait-timeout", type=float, default=900, help="separate CI observation budget in seconds (default: 900)")
    args = parser.parse_args(argv)
    if args.run < 1 or (args.pr is not None and args.pr < 1) or any(not 0 < value < float("inf") for value in [args.timeout, args.wait_timeout]) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", args.repo):
        parser.error("supply a valid repository, positive IDs and finite positive timeout")
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()).resolve()
    output = args.output or root / ".harness" / "validation" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-ci-{args.run}")
    output.mkdir(parents=True, exist_ok=False)
    waiting, observed, collection_started = None, None, None
    try:
        if args.wait:
            started = time.monotonic()
            waiting = {"started_at": utc_now()}
            try:
                observed = wait_for_run(Client(args.repo, started + args.wait_timeout), args.run)
                waiting.update(head_sha=observed["head_sha"], run_attempt=observed["run_attempt"])
            finally:
                waiting.update(finished_at=utc_now(), duration_seconds=round(time.monotonic() - started, 3))
        collection_started, started_at = time.monotonic(), utc_now()
        record = collect(Client(args.repo, collection_started + args.timeout), root, args.run, args.scope,
                         args.target, output, args.pr, expected_run=observed)
    except (ValueError, KeyError, TypeError, OSError, RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        record = {"schema": 1, "status": "collection_failed", "run_id": args.run, "error": str(error)}
    if waiting is not None:
        record["waiting"] = waiting
    if collection_started is not None:
        record["collection"] = {"started_at": started_at, "finished_at": utc_now(), "duration_seconds": round(time.monotonic() - collection_started, 3)}
    (output / "receipt.json").write_text(json.dumps(record, indent=2) + "\n")
    (output / "validation.md").write_text(markdown(record))
    elapsed = ", ".join(f"{record[phase]['duration_seconds']:g}s {phase}" for phase in ["waiting", "collection"] if phase in record)
    print(f"{record['status']} ({elapsed}): {output / 'validation.md'}")
    if "error" in record:
        print(record["error"], file=sys.stderr)
    return {"passed": 0, "source_review_required": 3}.get(record["status"], 1)


if __name__ == "__main__":
    sys.exit(main())
