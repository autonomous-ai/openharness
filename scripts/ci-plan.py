#!/usr/bin/env python3
"""Select fast CI suites from a complete Git diff and verify their final results.

A PR runs the unit suite of each component it changes, and nothing else. Merge
groups run only the plan and process checks: the PR run already covered the code.
After GitHub merges main into a PR head whose ci/required passed, a component whose
inputs main's new commits left untouched reuses that run's result instead of running
again (docs/validation-and-release.md#reuse-after-update-branch).
Checks outside PR CI are listed in docs/validation-and-release.md#what-pr-ci-does-not-run.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import time
import zipfile

_spec = importlib.util.spec_from_file_location("ci_evidence", Path(__file__).with_name("record-ci-validation.py"))
ci = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ci)


CORE = {"cli", "desktop", "tui", "backend", "companions"}
EXTRA = {"website", "os", "provider", "firmware", "mobile", "daemons", "pty"}
SUITES = CORE | EXTRA | {"pro"}
JOBS = {
    "cli": {"cli-typecheck", "cli-tests"},
    "pro": {"pro-firmware-build", "pro-golden"},
    "desktop": {"desktop-tests"},
    "tui": {"tui-test"}, "backend": {"backend-desk"}, "companions": {"companion-subsystems"},
    **{name: {name + "-checks"} for name in EXTRA},
}
MANUAL = {"full": CORE, "all": SUITES, "process": set(), **{name: {name} for name in SUITES}}
# Each component's own directory selects its suite. Everything else (docs, workflows,
# scripts, store, fixtures) is covered by the plan's actionlint and process checks.
COMPONENTS = {"cli": "cli", "tests": "cli", "desktop": "desktop", "tui": "tui", "backend": "backend",
              "companions": "companions", "website": "website", "os": "os", "provider": "provider",
              "devices": "firmware", "mobile": "mobile", "daemons": "daemons", "pty": "pty", "term": "pty",
              # harness-install.exe's model and steps test on Linux; its Windows half runs in windows-desktop.yml.
              "installer": "pty"}
# Paths inside another component that also select a suite: the PTY host's suite runs the CLI's
# ptyhost terminal contract against the host it builds, and the host builds on the vendored terminal.
# The shipped TUI (`hn`) builds on term/ as the host does, so a term/ change runs its tests too.
# The Windows pipe's shared proof vectors are read by the desktop app's test as well as the CLI's spec.
ALSO = {"cli/src/lib/ptyHost/": "pty", "cli/src/lib/ptyHostBackend": "pty",
        "cli/src/lib/terminalBackend.contract.ts": "pty", "tui/vendor/": "pty", "term/": "tui",
        "cli/src/lib/windows/__fixtures__/pipe-auth-vectors.json": "desktop"}
# Narrower directories that add a suite on top of their component's (the ESP32-P4 build and golden screens).
SUBCOMPONENTS = {"devices/harness-pro/": "pro"}

# Reuse after Update branch. A PR's own diff selects suites by the maps above; reusing an
# earlier result also needs every file a suite reads outside its own directory, because
# main's commits were never tested together with this PR. "dir/" is a prefix, else a file.
# test_ci_plan.CrossReadTests scans the components' sources and fails on an undeclared read.
# The desktop VM tests run in a sparse checkout of exactly these inputs (ci-source-inputs.py).
DEPENDS = {
    "backend": ("cli/src/lib/productHealthContract.ts", "cli/src/lib/productUsageContract.ts", "daemons/frames.json",
                "desktop/lib/measurement/", "desktop/lib/super_tabs/buddies.dart", "mobile/lib/measurement/",
                "provider/reference-provider/", "tests/fixtures/"),
    "cli": ("backend/src/lib/deviceAck.vectors.json", "backend/src/lib/deviceAckCore.ts", "desktop/",
            "devices/harness-device/firmware/test/vectors/", "mobile/", "pty/", "tui/src/shell_integration.sh"),
    "companions": ("cli/",),
    "desktop": ci.SOURCE_INPUTS["desktop"],
    "mobile": ("backend/src/types/productHealthContract.ts", "backend/src/types/productUsage.ts", "cli/src/",
               "daemons/banner.json", "daemons/frames.json", "daemons/plates.json", "daemons/roster.json", "desktop/"),
    "pty": ("desktop/windows/runner/resources/app_icon.ico",),
    "tui": ("cli/package.json", "tests/fixtures/shared-pane-layouts.json"),
    "website": ("backend/src/", "cli/packages/harness-mcp/", "desktop/lib/core/phone_app_links.dart",
                "desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_512.png"),
}
# Inputs every suite shares: a change here reruns everything, and a PR that changes them
# never reuses (PR CI runs the PR's own planner and workflow; the merge helper is in scripts/).
SHARED_PREFIXES = (".github/", "scripts/")
SHARED_FILES = {"Makefile", ".gitattributes", ".gitignore", ".gitmodules"}
LOCKS_AND_TOOLCHAINS = {
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lockb",
    "bun.lock", "Cargo.lock", "pubspec.lock", "go.sum", "go.mod", "go.work", "go.work.sum", "uv.lock", "poetry.lock",
    "Pipfile.lock", "Gemfile.lock", "Podfile.lock", "flake.lock", "gradle.lockfile", "composer.lock",
    ".nvmrc", ".node-version", ".tool-versions", ".python-version", ".ruby-version", ".go-version",
    "rust-toolchain", "rust-toolchain.toml", ".fvmrc", ".flutter-version", "global.json",
}


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
        scopes |= {also for prefix, also in ALSO.items() if path.startswith(prefix)}
        scopes |= {extra for prefix, extra in SUBCOMPONENTS.items() if path.startswith(prefix)}
        selected |= scopes
        reasons[path] = sorted(scopes)
    return selected, reasons


def covers(entry, path):
    return path == entry or (entry.endswith("/") and path.startswith(entry))


def inert(path):
    """Paths no suite reads: the docs (except the posters desktop shows) and top-level notes."""
    return ((path.startswith("docs/") and not path.startswith("docs/images/"))
            or ("/" not in path and path.endswith(".md")))


def shared_input(path):
    """Why a changed path invalidates every suite, or None."""
    if path.startswith(SHARED_PREFIXES) or path in SHARED_FILES:
        return "workflow, CI script, merge tool or repository setting"
    if PurePosixPath(path).name in LOCKS_AND_TOOLCHAINS:
        return "lockfile or toolchain pin"
    if not select([path])[0] and not inert(path):
        return "outside every component"
    return None


def reads(suite, path):
    return suite in select([path])[0] or any(covers(entry, path) for entry in DEPENDS.get(suite, ()))


def changed_paths(root, old, new):
    changed = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", old, new], cwd=root, timeout=120)
    return sorted(p.decode() for p in changed.split(b"\0") if p)


def is_ancestor(root, old, new):
    return subprocess.run(["git", "merge-base", "--is-ancestor", old, new], cwd=root, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=120).returncode == 0


def update_parents(root, head, base):
    """The passed head and main commit that GitHub's Update branch merged, or ValueError."""
    parents = git(root, "rev-list", "--parents", "-n", "1", head).split()[1:]
    if len(parents) != 2:
        raise Rerun("head is not a merge of main into an earlier head")
    passed, main = (sha(value) for value in parents)
    if not is_ancestor(root, main, base):
        raise Rerun("the merged main commit is not on the base branch")
    return passed, main


def own_shared_change(root, head, base):
    """A shared input this PR itself changes (its own CI runs its own planner), or None."""
    own = changed_paths(root, git(root, "merge-base", base, head), head)
    return next((path for path in own if path.startswith(SHARED_PREFIXES) or path in SHARED_FILES), None)


def reuse_blocker(root, suite, origin, head):
    """(scope, reason) when the result tested at origin cannot stand for head; scope "all" or "suite"."""
    if not is_ancestor(root, origin, head):
        return "suite", f"its recorded run tested {origin[:12]}, which is not an ancestor of this head"
    paths = changed_paths(root, origin, head)
    for path in paths:
        reason = shared_input(path)
        if reason:
            return "all", f"main changed {path} ({reason})"
    touched = [path for path in paths if reads(suite, path)]
    if touched:
        more = f" and {len(touched) - 1} more" if len(touched) > 1 else ""
        return "suite", f"main changed its input {touched[0]}{more}"
    return None, "; ".join(paths[:3]) + (f" and {len(paths) - 3} more" if len(paths) > 3 else "")


class Rerun(ValueError):
    """A deliberate refusal to reuse: its message is the receipt's reason."""


REUSE_ERRORS = (OSError, RuntimeError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError,
                zipfile.BadZipFile, json.JSONDecodeError)


def plan_reuse(root, head, base, suites, evidence):
    """Reuse what the passed head's exact ci/required run proved, for suites main's commits left alone.

    Fails closed: any doubt or unreadable evidence leaves every suite to run as before."""
    reuse = dict(status="none", reason=None, passed_head=None, main_parent=None, rerun={})
    reused = {}
    try:
        if evidence is None:
            raise Rerun("no CI evidence reader")
        passed, main = update_parents(root, head, base)
        reuse.update(passed_head=passed, main_parent=main)
        changed = own_shared_change(root, head, base)
        if changed:
            raise Rerun(f"this PR changes {changed}, which its own CI run reads")
        gate = evidence.passed_gate(passed)
        receipt = gate["receipt"]
        if receipt["source_sha"] != passed or receipt["status"] != "passed":
            raise ValueError("the passed head's ci/required receipt names another source")
        earlier = receipt.get("reused") or {}
        for suite in sorted(suites):
            if suite not in receipt["suites"]:
                reuse["rerun"][suite] = "the passed head's run did not run it"
                continue
            if suite in earlier:
                record = earlier[suite]
                origin, run_id, attempt = sha(record["origin_sha"]), record["run_id"], record["run_attempt"]
                found = evidence.ran(origin, run_id, attempt, suite)
                tree, url = found["tree"], found["url"]
            else:
                origin, run_id, attempt, tree, url = passed, gate["run_id"], gate["run_attempt"], receipt["source_tree"], gate["url"]
            scope, reason = reuse_blocker(root, suite, origin, head)
            if scope == "all":
                raise Rerun(reason)
            if scope == "suite":
                reuse["rerun"][suite] = reason
                continue
            reused[suite] = dict(origin_sha=origin, origin_tree=sha(tree), run_id=run_id, run_attempt=attempt, run_url=url,
                                 reason=f"passed in run {run_id} on {origin[:12]}; main's new commits change none of its inputs ({reason})")
    except Rerun as refusal:
        return {}, dict(reuse, rerun={}, reason=str(refusal))
    except REUSE_ERRORS as error:
        return {}, dict(reuse, rerun={}, reason=f"earlier evidence could not be verified: {str(error) or type(error).__name__}")
    reuse.update(status="applied" if reused else "none",
                 reason=f"reused {len(reused)} of {len(suites)} suites from the passed head's run")
    return reused, reuse


def make_plan(root, event_name, event, scope="full", source=None, evidence=None):
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
    reused, reuse = {}, dict(status="none", reason="only a ready PR's update merge can reuse", rerun={})
    if event_name == "pull_request" and not draft and suites:
        reused, reuse = plan_reuse(root, head, base_sha(event), suites, evidence)
    required = {"process-checks"} | set().union(*(JOBS[name] for name in suites - set(reused)))
    return dict(schema=1, kind="ci-plan", event=event_name, head=head, base=base, draft=draft,
                tree=git(root, "rev-parse", "HEAD^{tree}"), paths=paths, reasons=reasons,
                suites=sorted(suites), required_jobs=sorted(required), reused=reused, reuse=reuse,
                manual_acceptance="Review still selects relevant native, real-engine, hardware and visual acceptance.")


def base_sha(event):
    return sha(event["pull_request"]["base"]["sha"])


def verify(plan, needs, source):
    if plan.get("schema") != 1 or plan.get("kind") != "ci-plan" or plan.get("head") != sha(source):
        raise ValueError("CI plan identity does not match this source")
    sha(plan.get("tree"))
    if plan.get("draft") is not False:
        raise ValueError("Draft PR: complete component validation is deferred until ready_for_review")
    suites = plan.get("suites")
    if not isinstance(suites, list) or len(set(suites)) != len(suites) or not set(suites) <= SUITES:
        raise ValueError("invalid planned suites")
    reused = check_reused_records(plan.get("reused", {}), suites, plan["head"], plan.get("event"))
    expected = {"process-checks"} | set().union(*(JOBS[name] for name in set(suites) - set(reused)))
    if plan.get("required_jobs") != sorted(expected):
        raise ValueError("CI plan has incomplete job coverage")
    if needs.get("plan", {}).get("result") != "success":
        raise ValueError("CI planning did not pass")
    for job in expected:
        if needs.get(job, {}).get("result") != "success":
            raise ValueError(f"required CI job did not pass: {job}")
    for job in set().union(*(JOBS[name] for name in reused)):
        if needs.get(job, {}).get("result") != "skipped":
            raise ValueError(f"reused CI job ran again: {job}")
    for job, result in needs.items():
        if result.get("result") not in {"success", "skipped"}:
            raise ValueError(f"CI job did not complete successfully: {job}")
    return dict(schema=1, kind="ci-required", status="passed", source_sha=plan["head"],
                source_tree=plan["tree"], event=plan["event"], base=plan["base"],
                suites=suites, required_jobs=sorted(expected), results={k: v["result"] for k, v in needs.items()},
                reused=reused, reuse=plan.get("reuse"),
                run_id=int(os.environ.get("GITHUB_RUN_ID", "0")), run_attempt=int(os.environ.get("GITHUB_RUN_ATTEMPT", "0")))


RUN_URL = re.compile(r"https://github\.com/[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*/actions/runs/[1-9][0-9]*")


def positive(value):
    return type(value) is int and value > 0


def check_reused_records(reused, suites, head, event):
    """The shape of a plan's or receipt's reused results; the merge helper re-derives their substance."""
    if not isinstance(reused, dict) or not set(reused) <= set(suites):
        raise ValueError("reused suites must be planned suites")
    if reused and event != "pull_request":
        raise ValueError("only a pull request's update merge can reuse results")
    for suite, record in reused.items():
        if (not isinstance(record, dict) or not re.fullmatch(r"[0-9a-f]{40}", record.get("origin_sha") or "")
                or record["origin_sha"] == head
                or not re.fullmatch(r"[0-9a-f]{40}", record.get("origin_tree") or "")
                or not positive(record.get("run_id")) or not positive(record.get("run_attempt"))
                or not isinstance(record.get("run_url"), str) or not RUN_URL.fullmatch(record["run_url"])
                or not record["run_url"].endswith(f"/actions/runs/{record['run_id']}")
                or not isinstance(record.get("reason"), str)):
            raise ValueError(f"malformed reused result: {suite}")
    return reused


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
            # A reused suite's jobs skip; ci/required accepts that skip only for it.
            for suite in sorted(SUITES):
                runs = suite in record["suites"] and suite not in record["reused"]
                output.write(f"{suite}={'true' if runs else 'false'}\n")
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
