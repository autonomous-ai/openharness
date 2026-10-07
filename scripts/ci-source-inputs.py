#!/usr/bin/env python3
"""Enforce CI's declared source checkout and record its immutable input objects."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess

spec = importlib.util.spec_from_file_location("ci_evidence", Path(__file__).with_name("record-ci-validation.py"))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=root, stderr=subprocess.PIPE, timeout=15).decode().strip()


def verify_checkout(root, scope, subset=False):
    if git(root, "config", "--bool", "--default=false", "core.sparseCheckout") != "true":
        raise ValueError("CI source inputs require a sparse checkout")
    # actions/checkout leaves this unset in non-cone mode (Git defaults false).
    if git(root, "config", "--bool", "--default=false", "core.sparseCheckoutCone") != "false":
        raise ValueError("CI source inputs require literal non-cone patterns")
    declared = set(ci.SOURCE_INPUTS[scope])
    patterns = set(git(root, "sparse-checkout", "list").splitlines())
    def covered(path):
        return any(path == item.rstrip("/") or (item.endswith("/") and path.startswith(item)) for item in declared)
    if not patterns or any(not value.startswith("/") or any(c in value for c in "!*?[]\\")
                           or ".." in value.split("/") or not covered(value[1:].rstrip("/")) for value in patterns):
        raise ValueError("checkout includes source outside the declared CI inputs")
    if not subset and patterns != {"/" + path for path in declared}:
        raise ValueError("checkout does not match the complete declared CI inputs")
    entries = subprocess.check_output(["git", "ls-files", "-t", "-z"], cwd=root, timeout=15).decode().split("\0")
    for entry in filter(None, entries):
        flag, path = entry[:1], entry[2:]
        # Catch a populated file outside the sparse patterns, including when Git
        # still marks it skip-worktree. Directories are covered by their children.
        present = os.path.lexists(root / path)
        if not covered(path) and (flag != "S" or present):
            raise ValueError(f"undeclared tracked source is available: {path}")
    if git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("CI source checkout must be clean")


def capture(root):
    verify_checkout(root, "process")
    sha = git(root, "rev-parse", "HEAD")
    if os.environ.get("CI_SOURCE_SHA", os.environ.get("GITHUB_SHA")) != sha:
        raise ValueError("checkout differs from the CI source")
    run, attempt = (int(os.environ[key]) for key in ("GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
    if run < 1 or attempt < 1:
        raise ValueError("invalid CI run identity")
    return dict(schema=1, kind="ci-source-inputs", status="recorded", source_sha=sha,
                source_tree=git(root, "rev-parse", "HEAD^{tree}"), dirty=False, run_id=run, run_attempt=attempt,
                scopes={scope: ci.input_snapshot(root, sha, scope) for scope in ci.SOURCE_INPUTS})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scope", choices=ci.SOURCE_INPUTS)
    parser.add_argument("--subset", action="store_true", help="allow an aggregate's smaller checkout within the same contract")
    parser.add_argument("--record", type=Path, help="after process checks, record both contracts for this exact CI run")
    args = parser.parse_args()
    if args.record and (args.scope != "process" or args.subset):
        parser.error("recording requires the complete process checkout")
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel"))
    verify_checkout(root, args.scope, args.subset)
    if args.record:
        args.record.write_text(json.dumps(capture(root), indent=2) + "\n")
    print(f"Verified {args.scope} CI source checkout")


if __name__ == "__main__":
    main()
