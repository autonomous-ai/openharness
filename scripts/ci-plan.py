#!/usr/bin/env python3
"""Select coarse CI suites from a complete Git diff and verify their final results.

PRs test their exact head; merge groups test their exact combined candidate.
Manual scopes retain their existing meaning. Native/engine/hardware acceptance
selected during review remains additional to these automatic checks.
"""
import argparse
import fnmatch
import json
import os
from pathlib import Path
import re
import subprocess


CORE = {"cli", "desktop", "tui", "backend", "companions"}
EXTRA = {"website", "experience", "authoring", "home-assistant", "desktop-logging",
         "os", "provider", "firmware", "mobile", "daemons"}
SUITES = CORE | EXTRA
JOBS = {
    "cli": {"serial-native", "process-images-native", "cli-contracts", "cli-coverage-gates", "cli-tests", "typecheck-test"},
    "desktop": {"desktop-tests", "desktop-test-summary"},
    "tui": {"tui-test"}, "backend": {"backend-desk"}, "companions": {"companion-subsystems"},
    **{name: {name + "-checks"} for name in EXTRA},
}
MANUAL = {"full": CORE, "all": SUITES, "process": set(), **{name: {name} for name in SUITES}}
AUTHORING = {"generative-art", "music-studio", "creative-direction", "voxel-worlds",
             "drone-pilot", "game-master", "lab-bench", "data-studio"}
LOGGING = ["desktop/lib/logging/*", "desktop/test/app_log_test.dart", "desktop/test/buffered_log_test.dart",
           "desktop/test/crash_log_test.dart", "desktop/test/dial_log_tail_test.dart", "desktop/test/log_*_test.dart",
           "desktop/test/export_logs_dialog_test.dart", "desktop/test/cli_transcript_test.dart", "desktop/tool/log_append_probe.dart"]
SPECIAL_WORKFLOWS = {"website-checks.yml": "website", "experience-checks.yml": "experience",
                     "authoring-browser-checks.yml": "authoring", "home-assistant-checks.yml": "home-assistant",
                     "desktop-logging-checks.yml": "desktop-logging"}
ROOT_DOCS = {"AGENTS.md", "CHANGELOG.md", "CLAUDE.md", "CONTEXT.md", "CONTRIBUTING.md", "HANDOFF.md",
             "LICENSE", "README.md", "SECURITY.md", "claude_research.md"}


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE, timeout=120).decode().strip()


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise ValueError("CI requires a full immutable Git SHA")
    return value


def select(paths):
    selected, reasons, unknown = set(), {}, []
    for path in paths:
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
            raise ValueError("invalid changed path")
        scopes = set()
        root = path.split("/", 1)[0]
        if path in ROOT_DOCS or (root == "docs" and not path.startswith("docs/images/")):
            pass
        elif root in {".github", "scripts"} or path in {"Makefile", ".gitattributes", ".gitignore", ".gitmodules"}:
            # Keep existing source-input contracts conservative. Workflow/helper
            # changes invalidate all core suites until narrower contracts exist.
            scopes |= CORE
            if path in {".github/workflows/ci.yml", "scripts/ci-plan.py"}:
                scopes |= SUITES  # The shared planner/job graph controls every component.
            workflow = path.removeprefix(".github/workflows/")
            if workflow in SPECIAL_WORKFLOWS:
                scopes.add(SPECIAL_WORKFLOWS[workflow])
            if workflow.startswith("os-") or workflow == "os.yml":
                scopes.add("os")
        elif root == "cli":
            scopes |= CORE  # Desktop/TUI/companions consume CLI inputs.
            scopes.add("mobile")  # Phone protocol contracts read the CLI's frame definitions.
        elif root == "desktop":
            scopes.add("desktop")
            if path.startswith("desktop/assets/engine-icons/"):
                scopes.add("experience")
            if any(fnmatch.fnmatchcase(path, pattern) for pattern in LOGGING):
                scopes.add("desktop-logging")
        elif root in {"tui", "backend", "companions", "website", "os", "provider"}:
            scopes.add(root)
        elif root == "devices":
            scopes |= {"firmware", "cli", "desktop"}
        elif root == "mobile":
            scopes.add("mobile")
            if path == "mobile/pubspec.lock":
                scopes.add("desktop")
        elif root in {"tests", "daemons"}:
            scopes |= CORE | {"mobile", "daemons"}
        elif root == "store":
            scopes |= {"desktop", "experience"}
            if (path.startswith(("store/tools/", "store/viewers/web-viewer/"))
                    or any(path.startswith(f"store/agents/{name}/") for name in AUTHORING)):
                scopes.add("authoring")
            if path.startswith("store/agents/home-assistant/") or path in {"store/tools/runtimes.sh", "store/tools/sync-runtimes.mjs"}:
                scopes.add("home-assistant")
        elif path.startswith("docs/images/"):
            scopes.add("desktop")
        elif root in {"artifacts", "output", "work"}:
            scopes |= CORE
        else:
            unknown.append(path)
        selected |= scopes
        reasons[path] = sorted(scopes)
    if unknown:
        raise ValueError("register CI coverage for these paths before merging: " + ", ".join(unknown))
    return selected, reasons


def make_plan(root, event_name, event, scope="full", source=None):
    head = sha(source or git(root, "rev-parse", "HEAD"))
    if git(root, "rev-parse", "HEAD") != head:
        raise ValueError("checkout differs from the requested source")
    base = None
    paths, reasons = [], {}
    if event_name == "pull_request":
        pr = event["pull_request"]
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
    else:
        if scope not in MANUAL:
            raise ValueError("invalid manual CI scope")
        suites = MANUAL[scope]
    required = {"process-checks"} | set().union(*(JOBS[name] for name in suites))
    return dict(schema=1, kind="ci-plan", event=event_name, head=head, base=base,
                tree=git(root, "rev-parse", "HEAD^{tree}"), paths=paths, reasons=reasons,
                suites=sorted(suites), required_jobs=sorted(required),
                manual_acceptance="Review still selects relevant native, real-engine, hardware and visual acceptance.")


def verify(plan, needs, source):
    if plan.get("schema") != 1 or plan.get("kind") != "ci-plan" or plan.get("head") != sha(source):
        raise ValueError("CI plan identity does not match this source")
    sha(plan.get("tree"))
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
            for suite in sorted(SUITES):
                output.write(f"{suite}={'true' if suite in record['suites'] else 'false'}\n")
    args.output.write_text(json.dumps(record, indent=2) + "\n")
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
        summary.write(f"Source: `{record.get('head', record.get('source_sha'))}`\n\n")
        summary.write("Automatic suites: " + ", ".join(record["suites"] or ["repository process checks"]) + ".\n")
        summary.write("Native, real-engine, hardware and visual acceptance remain explicit review requirements.\n")
    print(json.dumps(record, indent=2))


if __name__ == "__main__":
    main()
