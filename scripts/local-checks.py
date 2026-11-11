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
    # `make desktop-test ARGS="--timeout N --workers N"` sets the budget and parallelism, never which tests run:
    # compiling all 1,022 test files does not fit the 900 s default on an Intel iMac, even an idle one.
    "desktop-macos": dict(command="make desktop-test", cwd=".", platform="macos", resource_args=("timeout", "workers"),
                          paths=("desktop/macos/*", "desktop/lib/*/mac_*.dart", "desktop/lib/*/macos*.dart",
                                 "desktop/test/macos*.dart", "desktop/pubspec.yaml", "desktop/pubspec.lock")),
}
CLI_SHARED = ("cli/package.json", "cli/package-lock.json", "cli/vitest.config.ts", "cli/vitest.setup.ts",
              "cli/vitest.tmpdir.ts", "cli/src/__fixtures__/vitestRun.ts", "cli/tsconfig*.json", "cli/.node-version", "cli/.nvmrc")
FENCE = re.compile(r"^```harness-local-checks\s*\n(.*?)^```[ \t]*$", re.MULTILINE | re.DOTALL)


def resource_args_ok(contract, command):
    prefix = contract["command"] + ' ARGS="'
    if not contract.get("resource_args") or not command.startswith(prefix) or not command.endswith('"'):
        return False
    words, named = command[len(prefix):-1].split(" "), set()
    if not words[0] or len(words) % 2:
        return False
    for option, value in zip(words[::2], words[1::2]):
        name = option.removeprefix("--")
        if (not option.startswith("--") or name not in contract["resource_args"] or name in named
                or not re.fullmatch(r"[1-9][0-9]{0,4}", value)):
            return False
        named.add(name)
    return True


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


def missing(required):
    # Only known names/commands are printed, never arbitrary PR content.
    return ValueError("Missing or invalid local check receipts: " + ", ".join(required)
                      + ". Add the exact-head harness-local-checks JSON receipt before PR validation; use --list for commands.")


def validate_receipts(required, receipts, head):
    if not required:
        return []
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise ValueError("invalid local check head")
    if not isinstance(receipts, list) or len(receipts) > 32:
        raise missing(required)
    found = {}
    for item in receipts:
        if not isinstance(item, dict) or not isinstance(item.get("check"), str):
            raise missing(required)
        name = item["check"]
        if name not in CHECKS or name in found:
            raise missing(required)
        contract = CHECKS[name]
        command = item.get("command")
        # Worker caps change resource use, not test selection or coverage. Reject
        # all other suffixes rather than accepting narrowed/disabled test runs.
        command_ok = isinstance(command, str) and (re.fullmatch(
            re.escape(contract["command"]) + r"(?: -- --maxWorkers(?:=| )[1-9][0-9]?)?", command)
            or resource_args_ok(contract, command))
        if (item.get("head") != head or item.get("status") != "passed"
                or type(item.get("passed")) is not int or item["passed"] <= 0
                or not command_ok or item.get("cwd") != contract["cwd"]
                or item.get("platform") not in ("macos", "linux", "windows")
                or (contract["platform"] and item["platform"] != contract["platform"])):
            raise missing(required)
        found[name] = {key: item[key] for key in ("check", "command", "cwd", "head", "status", "passed", "platform")}
    absent = sorted(set(required) - set(found))
    if absent:
        raise missing(absent)
    return [found[name] for name in required]


def check(plan, event):
    required = planned_checks(plan)
    if plan.get("event") != "pull_request":
        return []
    pr = event.get("pull_request", {})
    if pr.get("head", {}).get("sha") != plan.get("head"):
        raise ValueError("local check event differs from planned head")
    if plan.get("draft") is True or not required:
        return []
    body = pr.get("body") or ""
    if not isinstance(body, str) or len(body) > 65536:
        raise missing(required)
    blocks = FENCE.findall(body)
    if len(blocks) != 1:
        raise missing(required)
    try:
        receipts = json.loads(blocks[0])
    except (ValueError, RecursionError):
        raise missing(required) from None
    return validate_receipts(required, receipts, plan["head"])


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
