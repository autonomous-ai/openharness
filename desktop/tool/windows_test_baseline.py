#!/usr/bin/env python3
"""Compare a Windows run of the desktop suite with the failures recorded for it.

The whole desktop suite runs on Windows (.github/workflows/windows-desktop.yml; spec
docs/superpowers/specs/2026-10-18-windows-desktop-design.md, section 4.1). A test that assumes
POSIX (a /bin/sh fixture, a /Users/me path, file modes) fails there, and is recorded in
test/windows_known_failures.txt as `<file>::<test name>`. `check` fails on any other failure, on
any failure in MUST_PASS (the files that test the Windows branches), and on a run that did not
finish. A recorded test that passes now is named, so the list only shrinks.

  python tool/windows_test_baseline.py check --results run.json --baseline test/windows_known_failures.txt
  python tool/windows_test_baseline.py write --results x64.json --results arm64.json > test/windows_known_failures.txt
  python tool/windows_test_baseline.py show --results run.json --file test/hidden_process_test.dart
"""
import argparse
import json
import sys
from pathlib import Path

# Every test in these files must pass on Windows: they test the Windows branches themselves, so `write`
# refuses to record them and `check` fails on them. The whole plan's Windows test files are listed here from the
# start (a file that does not exist yet is simply never seen), so no later task's test can enter the baseline.
MUST_PASS = frozenset({
    # C1
    "test/home_dir_test.dart",
    "test/folder_commands_test.dart",
    "test/harness_cli_runner_windows_test.dart",
    "test/environment_provisioner_windows_test.dart",
    "test/hidden_process_test.dart",
    "test/viewer_mode_test.dart",
    "test/windows_boot_test.dart",
    # C2
    "test/windows_pipe_auth_test.dart",
    "test/daemon_pipe_record_test.dart",
    "test/windows_pipe_test.dart",
    "test/trusted_pipe_test.dart",
    "test/daemon_tcp_port_test.dart",
    "test/daemon_trusted_pipe_test.dart",
    # C3
    "test/windows_runner_contract_test.dart",
    "test/notification_link_test.dart",
    "test/windows_system_notifier_test.dart",
    "test/windows_status_tray_test.dart",
    "test/windows_clipboard_fonts_test.dart",
    "test/windows_shortcuts_test.dart",
    # C4
    "test/started_marker_test.dart",
    "test/windows_update_swap_test.dart",
    "test/windows_self_install_test.dart",
    "test/windows_self_install_boot_test.dart",
})

HEADER = """\
# Desktop tests that fail on Windows because they assume POSIX, one `<file>::<test name>` per line.
# Written by `python tool/windows_test_baseline.py write` from a Windows desktop workflow run, then
# reviewed: an entry belongs here only when its test exercises macOS or Linux behaviour. A failure
# in a Windows branch is fixed, never recorded. Remove an entry once its test passes on Windows.
"""


def suite_file(path):
    """`test/x_test.dart` for a suite's absolute path, with forward slashes."""
    text = path.replace("\\", "/")
    at = text.rfind("/test/")
    return text[at + 1:] if at >= 0 else text


def events_of(path):
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # Flutter also prints build output that is not JSON.
        if isinstance(event, dict):
            yield event


def outcomes(paths):
    """Outcomes and whether every log ended normally with all started tests finished."""
    found, complete = [], True
    for path in paths:
        suites, tests, pending, done, interrupted = {}, {}, set(), False, False
        for event in events_of(path):
            kind = event.get("type")
            if kind == "suite":
                suites[event["suite"]["id"]] = suite_file(event["suite"].get("path") or "")
            elif kind == "testStart":
                tests[event["test"]["id"]] = event["test"]
                pending.add(event["test"]["id"])
            elif kind == "testDone":
                pending.discard(event.get("testID"))
                test = tests.get(event.get("testID"))
                if test is None:
                    continue
                name = test.get("name", "")
                if name.startswith("loading "):
                    name = "(loading)"
                key = f"{suites.get(test.get('suiteID'), '?')}::{name}"
                found.append((key, event.get("result"), bool(event.get("skipped")), bool(event.get("hidden"))))
            elif kind == "done":
                # test_core emits success:null when its engine closes early.
                # A normal completed failure is success:false and stays valid.
                if isinstance(event.get("success"), bool):
                    done = True
                else:
                    interrupted = True
        complete = complete and done and not interrupted and not pending
    return found, complete


def read_runs(paths):
    """(failed, passed, complete): a test that failed on any run is failed."""
    failed, passed = set(), set()
    found, complete = outcomes(paths)
    for key, result, skipped, hidden in found:
        if skipped:
            continue
        if result == "success":
            if not hidden:
                passed.add(key)
        else:
            failed.add(key)  # a hidden entry that failed is a file that did not load
    return failed, passed - failed, complete


def read_baseline(path):
    entries = set()
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            entries.add(line)
    return entries


def must_pass(entries):
    return sorted(e for e in entries if e.split("::", 1)[0] in MUST_PASS)


def check(results, baseline_file, out=print):
    failed, passed, complete = read_runs(results)
    recorded = read_baseline(baseline_file)
    problems = []
    if not complete:
        problems.append("a run did not finish (missing/invalid 'done' status or tests without outcomes): it crashed or was cut short")
    required = must_pass(failed)
    problems += [f"must pass on Windows: {e}" for e in required]
    problems += [f"new failure: {e}" for e in sorted(failed - recorded) if e not in required]
    for entry in sorted(recorded & passed):
        out(f"::warning::passes on Windows now; remove it from {baseline_file}: {entry}")
    out(f"{len(failed)} failing, {len(failed & recorded)} of them recorded in {baseline_file}")
    for problem in problems:
        out(f"::error::{problem}")
    return 1 if problems else 0


def write(results, out=print):
    failed, _, complete = read_runs(results)
    if not complete:
        print("error: a run did not finish; record a baseline from a complete run", file=sys.stderr)
        return 1
    required = must_pass(failed)
    for entry in required:
        print(f"error: must pass on Windows, fix it instead: {entry}", file=sys.stderr)
    if required:
        return 1
    out(HEADER.rstrip("\n"))
    for entry in sorted(failed):
        out(entry)
    return 0


def show(results, file, out=print):
    """Each test of one file and how it ended, skips included: proof a Windows-only group ran."""
    found, _ = outcomes(results)
    for key, result, skipped, hidden in found:
        if key.split("::", 1)[0] == file and not hidden:
            out(f"{'skipped' if skipped else result} {key}")
    return 0


def main(argv=None):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["check", "write", "show"])
    parser.add_argument("--results", action="append", required=True, help="a flutter test JSON log; repeat for several")
    parser.add_argument("--baseline", default="test/windows_known_failures.txt")
    parser.add_argument("--file", help="show: the test file, as test/x_test.dart")
    args = parser.parse_args(argv)
    if args.mode == "check":
        return check(args.results, args.baseline)
    if args.mode == "write":
        return write(args.results)
    return show(args.results, args.file)


if __name__ == "__main__":
    sys.exit(main())
