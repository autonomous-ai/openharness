#!/usr/bin/env python3
"""Require bounded, exact-head local validation attestations in a PR body.

Before pushing the tested commit or marking Ready, add one harness-local-checks
JSON fence to the PR body. Each entry names check, command, cwd, head, status
(passed), passed (positive test count), and platform (macos, linux or windows).
Commands are data: this program never runs them. --list PATH... prints the
required checks and their commands before a PR validation run.
"""
import argparse
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import re
import sys


def cli_gate(name, *paths):
    return dict(command=f"npm run test:{name}", cwd="cli", platform=None,
                paths=paths + (f"cli/vitest.{name}.config.ts",))


# What a receipt's command may add to its check's: resource caps change the budget or parallelism, never which
# tests run or their coverage, so narrowed or disabled runs are still refused. Vitest takes a worker cap; the
# Desktop suite takes its total budget in seconds and its worker count (scripts/test-desktop.py).
MAX_WORKERS = r"(?: -- --maxWorkers(?:=| )[1-9][0-9]?)?"
_TIMEOUT, _WORKERS = r"--timeout [1-9][0-9]{2,4}", r"--workers [1-9][0-9]?"
DESKTOP_RESOURCES = rf'(?: ARGS="(?:{_TIMEOUT}(?: {_WORKERS})?|{_WORKERS}(?: {_TIMEOUT})?)")?'


# Keep coverage inputs aligned with cli/package.json and the coverage include
# lists in cli/vitest.*.config.ts. Directory patterns also cover new files/tests.
CHECKS = {
    "cli-core": cli_gate("core", "cli/src/core/*", "cli/src/services/*"),
    "cli-harnessd": cli_gate("harnessd", "cli/src/harnessd/*"),
    "cli-orchestrator": cli_gate("orchestrator", "cli/src/orchestrator/*"),
    "cli-sharing": cli_gate("sharing", "cli/src/sharing/*"),
    "cli-resume": cli_gate("resume", *(f"cli/src/lib/{name}*.ts" for name in (
        "conversationIdentity", "captureResumeIdentity", "resumeStoppedAgent", "resumeAgentService",
        "stoppedAgents", "stopAgentService", "controlTranscript", "sessionRepair"))),
    "cli-remote-viewers": cli_gate("remote-viewers", "cli/vitest.viewer.config.ts",
        *(f"cli/src/lib/{name}*.ts" for name in ("viewerFrames", "viewerWire", "viewerForwarder",
                                               "remoteViewerProxy", "remoteViewerRelay"))),
    "cli-portability": cli_gate("portability", "cli/src/dsh/*.ts", "cli/src/backendSocket.dsh.spec.ts",
        "cli/src/backendSocket.models.spec.ts", *(f"cli/src/lib/{name}*.ts" for name in (
            "newAgentModel", "launchOverrides", "createAgentPane", "registry"))),
    "cli-local-models": cli_gate("local-models", "cli/src/dsh/builtins*.ts", "cli/src/lib/localModels*.ts",
                                 "cli/src/lib/gridFleetRpc*.ts"),
    "cli-serial": dict(command="npx vitest run src/cable/serial.real.spec.ts --maxWorkers=1", cwd="cli", platform="macos",
                       paths=("cli/src/cable/serial*.ts", "cli/src/cable/windowsSerial*.ts", "cli/src/cable/__fixtures__/serial*")),
    "cli-pty": dict(command="npm run test:terminal-contract", cwd="cli", platform="macos",
                    paths=("cli/src/lib/ptyHost*", "cli/src/lib/tmuxBackend*", "cli/src/lib/terminalBackend*",
                           "pty/*", "term/*", "tui/vendor/*")),
    "cli-shell": dict(command="RUN_REAL_TMUX_DISCOVERY=1 npx vitest run src/lib/engineShellStartup.spec.ts --maxWorkers=1",
                      cwd="cli", platform="macos", paths=("cli/src/lib/engineLaunch*.ts", "cli/src/lib/engineShellStartup*.ts",
                                                         "cli/src/lib/engineShell*.ts", "cli/src/lib/zsh*.ts",
                                                         "cli/src/lib/loginShellEnv*.ts", "cli/src/lib/userShell*.ts",
                                                         "cli/src/lib/shellQuote*.ts")),
    "desktop-macos": dict(command="make desktop-test", cwd=".", platform="macos", resources=DESKTOP_RESOURCES,
                          paths=("desktop/macos/*", "desktop/lib/*/mac_*.dart", "desktop/lib/*/macos*.dart",
                                 "desktop/test/macos*.dart", "desktop/pubspec.yaml", "desktop/pubspec.lock")),
}
CLI_SHARED = ("cli/package.json", "cli/package-lock.json", "cli/vitest.config.ts", "cli/vitest.setup.ts",
              "cli/vitest.tmpdir.ts", "cli/src/__fixtures__/vitestRun.ts", "cli/tsconfig*.json", "cli/.node-version", "cli/.nvmrc")
# The most pull requests Harness's train carries (cli/src/superTabs/githubTrain.ts TRAIN_MAX).
TRAIN_MAX = 20
FENCE = re.compile(r"^```harness-local-checks\s*\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)


def required_checks(paths):
    selected = set()
    for path in paths:
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
            raise ValueError("invalid local check input path")
        selected.update(name for name, check in CHECKS.items() if any(fnmatchcase(path, p) for p in check["paths"]))
        if any(fnmatchcase(path, p) for p in CLI_SHARED):
            selected.update(name for name in CHECKS if name.startswith("cli-"))
    return sorted(selected)


def planned_checks(plan):
    required = required_checks(plan.get("paths", [])) if plan.get("event") == "pull_request" else []
    if plan.get("local_checks", []) != required:
        raise ValueError("CI plan has incomplete local check coverage")
    return required


def planned_heads(plan):
    """The checks a receipt must cover at each head it may name: the pull request's own, or on Harness's train only each
    member's, with the checks that member's own merge needs (ci-plan.py train_members). A train's head is a merge commit
    nobody ran anything on (train #4115 on 2026-11-11: no cli-core receipt could name it, so no CLI change could land)."""
    required = planned_checks(plan)
    members = plan.get("train_members", [])
    if members == []:
        return {plan["head"]: required}
    if (not isinstance(members, list) or len(members) > TRAIN_MAX
            or not all(isinstance(member, dict) and isinstance(member.get("head"), str)
                       and isinstance(member.get("local_checks"), list)
                       and member["local_checks"] == sorted(set(member["local_checks"]) & set(CHECKS))
                       for member in members)):
        raise ValueError("CI plan has incomplete local check coverage")
    heads = {member["head"]: member["local_checks"] for member in members}
    if len(heads) != len(members) or not set(required) <= {name for names in heads.values() for name in names}:
        raise ValueError("CI plan has incomplete local check coverage")
    return heads


def missing(required):
    # Only known names/commands are printed, never arbitrary PR content.
    return ValueError("Missing or invalid local check receipts: " + ", ".join(required)
                      + ". Add the exact-head harness-local-checks JSON receipt before PR validation; use --list for commands.")


def validate_receipts(heads, receipts):
    """The receipts for every check each of [heads] ({head: [check]}) needs at that head, in that order."""
    wanted = [(head, name) for head, names in heads.items() for name in names]
    if not wanted:
        return []
    if not all(isinstance(head, str) and re.fullmatch(r"[0-9a-f]{40}", head) for head in heads):
        raise ValueError("invalid local check head")
    one = len(heads) == 1
    required = sorted({name if one else f"{name} at {head[:7]}" for head, name in wanted})
    if not isinstance(receipts, list) or len(receipts) > 32 * len(heads):
        raise missing(required)
    found = {}
    for item in receipts:
        if not isinstance(item, dict) or not isinstance(item.get("check"), str) or not isinstance(item.get("head"), str):
            raise missing(required)
        name, head = item["check"], item["head"]
        if name not in CHECKS or head not in heads or (head, name) in found:
            raise missing(required)
        contract = CHECKS[name]
        command = item.get("command")
        command_ok = isinstance(command, str) and re.fullmatch(
            re.escape(contract["command"]) + contract.get("resources", MAX_WORKERS), command)
        if (item.get("status") != "passed"
                or type(item.get("passed")) is not int or item["passed"] <= 0
                or not command_ok or item.get("cwd") != contract["cwd"]
                or item.get("platform") not in ("macos", "linux", "windows")
                or (contract["platform"] and item["platform"] != contract["platform"])):
            raise missing(required)
        found[head, name] = {key: item[key] for key in ("check", "command", "cwd", "head", "status", "passed", "platform")}
    absent = [name if one else f"{name} at {head[:7]}" for head, name in wanted if (head, name) not in found]
    if absent:
        raise missing(absent)
    return [found[key] for key in wanted]


def check(plan, event):
    heads = planned_heads(plan)
    if plan.get("event") != "pull_request":
        return []
    pr = event.get("pull_request", {})
    if pr.get("head", {}).get("sha") != plan.get("head"):
        raise ValueError("local check event differs from planned head")
    if plan.get("draft") is True:
        return []
    body = pr.get("body") or ""
    # Anything but one fence of JSON in a bounded body is no receipt: validate_receipts names what is missing.
    blocks = FENCE.findall(body) if isinstance(body, str) and len(body) <= 65536 else []
    try:
        receipts = json.loads(blocks[0]) if len(blocks) == 1 else None
    except (ValueError, RecursionError):
        receipts = None
    return validate_receipts(heads, receipts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", nargs="+", metavar="PATH")
    args = parser.parse_args()
    if args.list:
        print(json.dumps({name: {k: v for k, v in CHECKS[name].items() if k != "paths"}
                          for name in required_checks(args.list)}, indent=2))
        return
    plan = json.loads(os.environ["CI_PLAN"])
    if plan.get("head") != os.environ["CI_SOURCE_SHA"] or plan.get("event") != os.environ["GITHUB_EVENT_NAME"]:
        raise ValueError("local check source differs from CI plan")
    records = check(plan, json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write("local_receipts=" + json.dumps(records, separators=(",", ":")) + "\n")
    print(f"Local check receipts verified: {len(records)}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError):
        # The validation errors contain only fixed copy/known check ids. JSON and
        # IO errors can contain PR text or paths, so do not print their payloads.
        error = sys.exc_info()[1]
        message = str(error)
        if not message.startswith(("Missing or invalid local check receipts:", "CI plan has incomplete local check",
                                   "local check ", "invalid local check")):
            message = "Invalid local check input; no receipt accepted."
        print(message, file=sys.stderr)
        sys.exit(1)
