#!/usr/bin/env python3
"""Verify complete Desktop VM coverage from bounded runner receipts and raw logs."""
import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("desktop_tests", Path(__file__).with_name("test-desktop.py"))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
PLATFORMS = {"ubuntu-22.04": "linux", "macos-15": "darwin"}


def verify_receipt(path, source, inventory, platform, index, shards):
    receipt = json.loads(path.read_text())
    if (receipt.get("schema") != 1 or receipt.get("kind") != "desktop-vm"
            or receipt.get("platform") != platform or source.get("dirty")
            or receipt.get("source") != source or receipt.get("source_after") != source
            or not receipt.get("identity") or receipt.get("identity") != receipt.get("identity_after")):
        raise ValueError("receipt source, platform or environment differs")
    shard = receipt.get("shard", {})
    if (type(shard.get("index")) is not int or type(shard.get("total")) is not int
            or shard != dict(index=index, total=shards, inventory=inventory)):
        raise ValueError("shard identity or full discovery inventory differs")
    desktop = Path(receipt["desktop_root"])
    if not desktop.is_absolute() or ".." in desktop.parts:
        raise ValueError("invalid producer checkout path")

    def relative(value):
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError("invalid reported test path")
        return path.relative_to(desktop).as_posix()

    selected = receipt["selected_files"]
    if [relative(p) for p in selected] != driver.partition(inventory, (index, shards)):
        raise ValueError("selected files do not match the assigned shard")
    checks = receipt.get("checks", [])
    if not isinstance(checks, list) or len(checks) not in {1, 2}:
        raise ValueError("missing or unexpected test attempts")

    def report(check, paths, name):
        if check.get("cleanup_error"):
            raise ValueError("test process cleanup failed")
        if check.get("name") != name or Path(check["log"]).name != name + ".log":
            raise ValueError("unexpected attempt or log path")
        log = path.parent / (name + ".log")
        if log.is_symlink() or driver.validation.file_sha256(log) != check.get("log_sha256"):
            raise ValueError("test log digest differs")
        actual = driver.summarize(log, paths)
        if actual != check.get("report"):
            raise ValueError("receipt disagrees with its raw test log")
        return actual

    first = report(checks[0], selected, "desktop-vm")
    results = dict(first["files"])
    retried = []
    if len(checks) == 1:
        if (receipt.get("status") != "passed" or checks[0].get("exit_code") != 0
                or not driver.passed(checks[0], first)):
            raise ValueError("test attempt did not pass completely")
    else:
        candidates = driver.retry_files(checks[0], first)
        if (not candidates or receipt.get("retried_files") != candidates
                or receipt.get("status") != "passed_after_startup_retry"):
            raise ValueError("invalid loader recovery")
        retried = [relative(p) for p in candidates]
        recovered = report(checks[1], candidates, "desktop-vm-loader-retry")
        if checks[1].get("exit_code") != 0 or not driver.passed(checks[1], recovered):
            raise ValueError("loader recovery did not pass completely")
        results.update(recovered["files"])
    if any(item["status"] != "passed" for item in results.values()):
        raise ValueError("a test file remains incomplete")
    coverage = dict(files=len(results), verified_files=len(results),
                    passed=sum(item["passed"] for item in results.values()),
                    skipped=sum(item["skipped"] for item in results.values()))
    if coverage != receipt.get("coverage"):
        raise ValueError("receipt coverage totals disagree with its logs")
    return {relative(p): result for p, result in results.items()}, dict(
        shard=index, **coverage, recovered_files=retried,
        receipt_sha256=driver.validation.file_sha256(path))


def verify(directory, root, shards, tests_result):
    if tests_result != "success":
        raise ValueError(f"the complete Desktop matrix must pass: {tests_result}")
    expected_folders = {f"desktop-shard-{label}-{index}" for label in PLATFORMS for index in range(1, shards + 1)}
    if {path.name for path in directory.glob("desktop-shard-*")} != expected_folders:
        raise ValueError("missing or unexpected shard artifacts")
    source = driver.validation.source_state(root)
    inventory = [Path(p).relative_to(root / "desktop").as_posix()
                 for p in driver.select_files(root / "desktop", [])]
    platforms = []
    for label, platform in PLATFORMS.items():
        seen, counts = Counter(), Counter(passed=0, skipped=0)
        records = []
        for index in range(1, shards + 1):
            folder = directory / f"desktop-shard-{label}-{index}"
            receipts = list(folder.rglob("receipt.json"))
            if len(receipts) != 1 or receipts[0].is_symlink():
                raise ValueError(f"{label} shard {index}: expected exactly one receipt")
            results, record = verify_receipt(receipts[0], source, inventory, platform, index, shards)
            seen.update(results.keys())
            counts.update({key: record[key] for key in counts})
            records.append(record)
        if set(seen) != set(inventory) or any(count != 1 for count in seen.values()):
            raise ValueError(f"{label}: files are missing, unexpected or duplicated")
        platforms.append(dict(platform=label, files=len(seen), **dict(counts),
                              verified_files=sorted(seen), shards=records))
    return dict(schema=1, kind="desktop-vm-ci", status="passed", source=source,
                platforms=platforms)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--shards", type=int, default=4)
    parser.add_argument("--tests-result", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.shards < 1:
        parser.error("shards must be positive")
    result = verify(args.directory, args.root.resolve(), args.shards, args.tests_result)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    for platform in result["platforms"]:
        print(f"{platform['platform']}: {platform['files']} files verified exactly once; "
              f"{platform['passed']} passed, {platform['skipped']} skipped")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Desktop shard verification failed: {error}", file=sys.stderr)
        sys.exit(1)
