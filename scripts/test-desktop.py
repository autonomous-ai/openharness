#!/usr/bin/env python3
"""Run Desktop VM tests with bounded workers and one narrowly scoped loader retry.

Browser and native integration tests remain separate checks. All attempts, errors,
per-file counts and source/toolchain identities are retained in the receipt.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

SPEC = importlib.util.spec_from_file_location("validate_change", Path(__file__).with_name("validate-change.py"))
validation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)

LOADER_ERROR = "Unable to connect to flutter_tester process: WebSocketException: Invalid WebSocket upgrade request"


def default_workers():
    cpus = os.cpu_count() or 2
    # Twelve workers improved the complete suite on a 16-CPU host. Leave a
    # quarter of large hosts free; retain the existing share on smaller hosts.
    share = cpus * 3 // 4 if cpus >= 16 else cpus // 2
    return min(12, max(1, share))


def summarize(log, selected):
    """Fail closed on missing files/cases, hidden errors and incomplete reporters."""
    suites, tests, ends, errors, counts = {}, {}, {}, {}, {}
    done = []
    problems = []
    for line in log.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # Flutter also writes non-JSON build/progress output.
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        try:
            if kind == "suite":
                suite = event["suite"]
                if suite["id"] in suites or suite.get("platform") != "vm":
                    raise ValueError("duplicate or non-VM suite")
                suites[suite["id"]] = str(Path(suite["path"]).resolve())
            elif kind == "testStart":
                test = event["test"]
                if test["id"] in tests:
                    raise ValueError("duplicate test start")
                tests[test["id"]] = test
            elif kind == "testDone":
                if event["testID"] in ends:
                    raise ValueError("duplicate test completion")
                if (type(event.get("hidden")) is not bool or type(event.get("skipped")) is not bool
                        or event.get("result") not in {"success", "failure", "error"}):
                    raise ValueError("invalid test completion")
                ends[event["testID"]] = event
            elif kind == "error":
                errors.setdefault(event["testID"], []).append(event)
            elif kind == "group" and event["group"]["parentID"] is None:
                group = event["group"]
                if group["suiteID"] in counts or type(group["testCount"]) is not int or group["testCount"] < 0:
                    raise ValueError("invalid root group count")
                counts[group["suiteID"]] = group["testCount"]
            elif kind == "done":
                done.append(event["success"])
        except (KeyError, TypeError, ValueError) as error:
            problems.append(f"invalid {kind} event: {error}")

    if len(done) != 1 or type(done[0]) is not bool:
        problems.append("reporter did not finish exactly once")
    if set(suites.values()) != set(selected) or len(set(suites.values())) != len(suites):
        problems.append("reported files do not match selected files")
    if set(ends) - set(tests) or set(errors) - set(tests):
        problems.append("result/error without a registered test")
    if any(test.get("suiteID") not in suites for test in tests.values()) or set(counts) - set(suites):
        problems.append("test/group without a registered suite")

    files = {}
    for suite_id, path in suites.items():
        started = {tid: test for tid, test in tests.items() if test.get("suiteID") == suite_id}
        finished = {tid: ends[tid] for tid in started if tid in ends}
        visible = [end for end in finished.values() if end.get("hidden") is False]
        file_errors = [e for tid in started for e in errors.get(tid, [])]
        all_finished = len(started) == len(finished)
        all_success = all(end.get("result") == "success" for end in finished.values())
        complete = all_finished and all_success and not file_errors and counts.get(suite_id) == len(visible)
        # A matching string in an assertion or setUpAll is NOT a loader failure.
        # The loader must be the only started test, with no registered root group.
        loader = len(started) == 1 and suite_id not in counts and all_finished and len(file_errors) == 1
        if loader:
            tid, test = next(iter(started.items()))
            error = file_errors[0]
            loader = (
                test.get("groupIDs") == [] and test.get("name") == f"loading {path}"
                and error.get("isFailure") is False
                and error.get("error") == f'Failed to load "{path}": {LOADER_ERROR}'
                and finished[tid].get("result") == "error"
                and finished[tid].get("skipped") is False
            )
        files[path] = {
            "status": "passed" if complete else ("startup_error" if loader else "failed_or_incomplete"),
            "registered_cases": counts.get(suite_id),
            "passed": sum(e.get("result") == "success" and e.get("skipped") is False for e in visible),
            "skipped": sum(e.get("result") == "success" and e.get("skipped") is True for e in visible),
            "errors": [{"error": e.get("error"), "is_failure": e.get("isFailure")} for e in file_errors],
        }
    return {"files": files, "problems": problems, "reported_success": done[0] if len(done) == 1 else None}


def retry_files(check, report):
    if check.get("status") != "failed" or check.get("exit_code") != 1 or check.get("cleanup_error"):
        return []
    if report["problems"] or report["reported_success"] is not False:
        return []
    if any(f["status"] not in {"passed", "startup_error"} for f in report["files"].values()):
        return []
    return sorted(path for path, result in report["files"].items() if result["status"] == "startup_error")


def passed(check, report):
    return (check.get("status") == "passed" and not report["problems"]
            and report["reported_success"] is True
            and all(f["status"] == "passed" for f in report["files"].values()))


def select_files(desktop, paths):
    base = (desktop / "test").resolve()
    files = [desktop / path for path in paths] if paths else sorted(base.rglob("*_test.dart"))
    selected = []
    for path in files:
        resolved = path.resolve()
        if not resolved.is_relative_to(base) or not path.is_file() or not path.name.endswith("_test.dart") or path.is_symlink():
            raise ValueError(f"expected a VM test file under desktop/test: {path}")
        if resolved.is_relative_to(base / "web"):
            if paths:
                raise ValueError("browser tests require their separate Chrome command")
            continue
        selected.append(str(resolved))
    if not selected:
        raise ValueError("no VM test files selected")
    return sorted(set(selected))


def shard_pair(value):
    if not re.fullmatch(r"[1-9][0-9]*/[1-9][0-9]*", value):
        raise argparse.ArgumentTypeError("shard must be INDEX/TOTAL, starting at 1")
    index, total = map(int, value.split("/"))
    if index > total:
        raise argparse.ArgumentTypeError("shard index exceeds total")
    return index, total


def partition(files, shard):
    index, total = shard
    selected = files[index - 1::total]
    if not selected:
        raise ValueError("shard has no test files; reduce the shard count")
    return selected


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", help="desktop-relative test/foo_test.dart paths; default: every VM test")
    parser.add_argument("--flutter", default="flutter", help="Flutter executable (dependencies must already be installed)")
    parser.add_argument("--workers", type=int, default=default_workers())
    parser.add_argument("--shard", type=shard_pair, default=(1, 1), help="run INDEX/TOTAL of the complete selected file inventory")
    parser.add_argument("--timeout", type=float, default=900, help="total attempt budget in seconds, including recovery (default: 900)")
    parser.add_argument("--no-loader-retry", action="store_true", help="retain the first failure without recovery")
    args = parser.parse_args(argv)
    if os.name != "posix":
        parser.error("process-group cleanup requires macOS or Linux")
    if args.workers < 1 or not 0 < args.timeout < float("inf"):
        parser.error("workers and timeout must be positive and finite")
    root = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()).resolve()
    desktop = root / "desktop"
    inventory = select_files(desktop, args.files)
    selected = partition(inventory, args.shard)
    flutter = shutil.which(args.flutter)
    if flutter is None:
        raise ValueError(f"Flutter executable unavailable: {args.flutter}")
    workers = min(args.workers, len(selected))
    output = root / ".harness" / "validation" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ") + f"-desktop-{os.getpid()}")
    output.mkdir(parents=True)
    started = time.monotonic()
    deadline = started + args.timeout
    receipt = dict(schema=1, kind="desktop-vm", started_at=validation.utc_now(), source=validation.source_state(root),
                   workers=workers, logical_cpus=os.cpu_count(), timeout_seconds=args.timeout,
                   selected_files=selected, checks=[], status="blocked", platform=sys.platform,
                   desktop_root=str(desktop.resolve()),
                   shard=dict(index=args.shard[0], total=args.shard[1],
                              inventory=[str(Path(path).relative_to(desktop)) for path in inventory]))
    # Reuse the common runner's source/toolchain/environment identity and owned
    # process cleanup. This driver never reuses results from an earlier invocation.
    identity_plan = {"checks": [{"name": "desktop-vm", "argv": [flutter, "test"], "cwd": "desktop",
                               "reuse": {"inputs": ["desktop", "scripts/test-desktop.py", "scripts/validate-change.py"],
                                         "toolchain": [[flutter, "--version", "--machine"], [sys.executable, "--version"]]}}]}

    def attempt(name, paths, concurrency):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("total test budget exhausted before next attempt")
        check = {"name": name, "cwd": "desktop", "timeout_seconds": remaining,
                 "argv": [flutter, "test", "--no-pub", f"--concurrency={concurrency}", "--reporter=json", *paths]}
        result = validation.run_checks({"checks": [check]}, root, output, 1)[0]
        receipt["checks"].append(result)
        if result.get("log") and Path(result["log"]).exists():
            result["log_sha256"] = validation.file_sha256(Path(result["log"]))
            report = summarize(Path(result["log"]), paths)
        else:
            report = {"files": {}, "problems": ["no test log"], "reported_success": None}
        result["report"] = report
        print(f"{name}: {sum(f['passed'] for f in report['files'].values())} passed, "
              f"{sum(f['skipped'] for f in report['files'].values())} skipped, "
              f"{sum(f['status'] != 'passed' for f in report['files'].values())} unverified files", flush=True)
        for problem in report["problems"]:
            print(f"{name}: {problem}", flush=True)
        return result, report

    def unchanged(identity):
        receipt["source_after"] = validation.source_state(root)
        receipt["identity_after"] = validation.reuse_keys(identity_plan, root)
        return receipt["source"] == receipt["source_after"] and identity == receipt["identity_after"]

    try:
        free = shutil.disk_usage(root).free / 1024 ** 3
        receipt["free_gib_before"] = round(free, 3)
        if free < 2:
            raise ValueError(f"Only {free:.2f} GiB free; tests require at least 2 GiB")
        identity = validation.reuse_keys(identity_plan, root)
        receipt["identity"] = identity
        print(f"Desktop VM: {len(selected)} files, {workers} workers, {args.timeout:g}s total budget", flush=True)
        first, report = attempt("desktop-vm", selected, workers)
        candidates = retry_files(first, report) if not args.no_loader_retry else []
        final_files = dict(report["files"])
        receipt["status"] = "passed" if passed(first, report) else "failed"
        if not unchanged(identity):
            receipt.update(status="source_changed", error="Source, toolchain or environment changed during validation")
        elif candidates:
            receipt["retried_files"] = candidates
            print(f"Retrying {len(candidates)} pre-test WebSocket loader failures once at one worker; original errors retained", flush=True)
            retry, retry_report = attempt("desktop-vm-loader-retry", candidates, 1)
            final_files.update(retry_report["files"])
            receipt["status"] = "passed_after_startup_retry" if passed(retry, retry_report) else "failed"
            if not unchanged(identity):
                receipt.update(status="source_changed", error="Source, toolchain or environment changed during validation")
        receipt["coverage"] = {"files": len(final_files),
                               "verified_files": sum(f["status"] == "passed" for f in final_files.values()),
                               "passed": sum(f["passed"] for f in final_files.values()),
                               "skipped": sum(f["skipped"] for f in final_files.values())}
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        receipt.update(status="blocked", error=str(error))
    receipt.update(finished_at=validation.utc_now(), duration_seconds=round(time.monotonic() - started, 3))
    path = output / "receipt.json"
    path.write_text(json.dumps(receipt, indent=2) + "\n")
    print(f"{receipt['status']}: {path}", flush=True)
    return 0 if receipt["status"] in {"passed", "passed_after_startup_retry"} else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f"desktop test error: {error}", file=sys.stderr)
        sys.exit(2)
