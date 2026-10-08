#!/usr/bin/env python3
"""Select fast CI suites from a complete Git diff and verify their final results.

A PR runs the unit suite of each component it changes, and nothing else. Merge
groups run only the plan and process checks: the PR run already covered the code.
Checks outside PR CI are listed in docs/validation-and-release.md#what-pr-ci-does-not-run.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess


CORE = {"cli", "desktop", "tui", "backend", "companions"}
EXTRA = {"website", "os", "provider", "firmware", "mobile", "daemons"}
SUITES = CORE | EXTRA
JOBS = {
    "cli": {"cli-typecheck", "cli-tests"},
    "desktop": {"desktop-tests"},
    "tui": {"tui-test"}, "backend": {"backend-desk"}, "companions": {"companion-subsystems"},
    **{name: {name + "-checks"} for name in EXTRA},
}
MANUAL = {"full": CORE, "all": SUITES, "process": set(), **{name: {name} for name in SUITES}}
# Each component's own directory selects its suite. Everything else (docs, workflows,
# scripts, store, fixtures) is covered by the plan's actionlint and process checks.
COMPONENTS = {"cli": "cli", "tests": "cli", "desktop": "desktop", "tui": "tui", "backend": "backend",
              "companions": "companions", "website": "website", "os": "os", "provider": "provider",
              "devices": "firmware", "mobile": "mobile", "daemons": "daemons"}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE, timeout=120).decode().strip()


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("CI requires a full immutable Git SHA")
    return value


def select(paths):
    selected, reasons = set(), {}
    for path in paths:
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
            raise ValueError("invalid changed path")
        suite = COMPONENTS.get(path.split("/", 1)[0])
        scopes = {suite} if suite else set()
        selected |= scopes
        reasons[path] = sorted(scopes)
    return selected, reasons


def make_plan(root, event_name, event, scope="full", source=None):
    head = sha(source or git(root, "rev-parse", "HEAD"))
    if git(root, "rev-parse", "HEAD") != head:
        raise ValueError("checkout differs from the requested source")
    base = None
    draft = False
    paths, reasons = [], {}
    if event_name == "pull_request":
        pr = event["pull_request"]
        draft = pr.get("draft", False)
        if not isinstance(draft, bool):
            raise ValueError("invalid PR draft state")
        if sha(pr["head"]["sha"]) != head:
            raise ValueError("PR head differs from the checkout")
        # Use Git, not the event's truncated paths or GitHub's limited file API.
        base = sha(git(root, "merge-base", sha(pr["base"]["sha"]), head))
    elif event_name == "merge_group":
        group = event["merge_group"]
        if event.get("action") != "checks_requested" or sha(group["head_sha"]) != head:
            raise ValueError("merge group differs from the checkout")
        base = sha(group["base_sha"])
        git(root, "merge-base", "--is-ancestor", base, head)
    elif event_name not in {"workflow_dispatch", "workflow_call"}:
        raise ValueError("unsupported CI event")
    if base:
        # Treat renames as deletion + addition so both input boundaries apply.
        changed = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", base, head], cwd=root, timeout=120)
        paths = sorted(p.decode() for p in changed.split(b"\0") if p)
        suites, reasons = select(paths)
        if event_name == "merge_group":
            suites = set()  # The PR run tested these changes; releases test the rest.
    else:
        if scope not in MANUAL:
            raise ValueError("invalid manual CI scope")
        suites = MANUAL[scope]
    required = {"process-checks"} | set().union(*(JOBS[name] for name in suites))
    return dict(schema=1, kind="ci-plan", event=event_name, head=head, base=base, draft=draft,
                tree=git(root, "rev-parse", "HEAD^{tree}"), paths=paths, reasons=reasons,
                suites=sorted(suites), required_jobs=sorted(required),
                manual_acceptance="Review still selects relevant native, real-engine, hardware and visual acceptance.")


def verify(plan, needs, source):
    if plan.get("schema") != 1 or plan.get("kind") != "ci-plan" or plan.get("head") != sha(source):
        raise ValueError("CI plan identity does not match this source")
    sha(plan.get("tree"))
    if plan.get("draft") is not False:
        raise ValueError("Draft PR: complete component validation is deferred until ready_for_review")
    suites = plan.get("suites")
    if not isinstance(suites, list) or len(set(suites)) != len(suites) or not set(suites) <= SUITES:
        raise ValueError("invalid planned suites")
    expected = {"process-checks"} | set().union(*(JOBS[name] for name in suites))
    if plan.get("required_jobs") != sorted(expected):
        raise ValueError("CI plan has incomplete job coverage")
    if needs.get("plan", {}).get("result") != "success":
        raise ValueError("CI planning did not pass")
    for job in expected:
        if needs.get(job, {}).get("result") != "success":
            raise ValueError(f"required CI job did not pass: {job}")
    for job, result in needs.items():
        if result.get("result") not in {"success", "skipped"}:
            raise ValueError(f"CI job did not complete successfully: {job}")
    return dict(schema=1, kind="ci-required", status="passed", source_sha=plan["head"],
                source_tree=plan["tree"], event=plan["event"], base=plan["base"],
                suites=suites, required_jobs=sorted(expected), results={k: v["result"] for k, v in needs.items()},
                run_id=int(os.environ.get("GITHUB_RUN_ID", "0")), run_attempt=int(os.environ.get("GITHUB_RUN_ATTEMPT", "0")))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--scope", default="full")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.verify:
        plan = json.loads(os.environ["CI_PLAN"])
        if (git(Path.cwd(), "rev-parse", "HEAD") != os.environ["CI_SOURCE_SHA"]
                or git(Path.cwd(), "rev-parse", "HEAD^{tree}") != plan.get("tree")):
            raise ValueError("CI gate checkout differs from the planned source")
        record = verify(plan, json.loads(os.environ["CI_NEEDS"]), os.environ["CI_SOURCE_SHA"])
    else:
        record = make_plan(Path.cwd(), os.environ["GITHUB_EVENT_NAME"],
                           json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()), args.scope, os.environ["CI_SOURCE_SHA"])
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("plan=" + json.dumps(record, separators=(",", ":")) + "\n")
            output.write(f"ready={'false' if record['draft'] else 'true'}\n")
            for suite in sorted(SUITES):
                output.write(f"{suite}={'true' if suite in record['suites'] else 'false'}\n")
    args.output.write_text(json.dumps(record, indent=2) + "\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Source: `{record.get('head', record.get('source_sha'))}`\n\n")
        summary.write("Automatic suites: " + ", ".join(record["suites"] or ["repository process checks"]) + ".\n")
        if record.get("draft"):
            summary.write("Draft PR: only workflow/process checks run; mark ready for review to run the complete affected suites. The integration gate remains blocked.\n")
        summary.write("Native, real-engine, hardware and visual acceptance remain explicit review requirements.\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
