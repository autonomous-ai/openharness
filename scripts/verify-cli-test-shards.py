#!/usr/bin/env python3
"""Verify that passing Vitest CI shards cover the discovered file set exactly once."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys


def verify(directory, root, shards, tests_result, contracts_result):
    # Vitest JSON can say success even when an unhandled error makes its process
    # fail. Require the actual matrix/contract job verdicts, not JSON alone.
    if tests_result != "success" or contracts_result != "success":
        raise ValueError(f"upstream jobs must pass: tests={tests_result}, contracts={contracts_result}")
    expected, seen = None, Counter()
    totals = Counter(passed=0, skipped=0, todo=0)
    receipts = []

    def relative(value):
        if not isinstance(value, str):
            raise ValueError("test paths must be strings")
        path = Path(value)
        if not path.is_absolute():
            raise ValueError(f"expected an absolute Vitest file path: {value}")
        result = path.resolve().relative_to(root.resolve()).as_posix()
        if not result.startswith("src/") or not result.endswith((".spec.ts", ".test.ts")):
            raise ValueError(f"unexpected test path: {result}")
        return result

    for shard in range(1, shards + 1):
        inventory_path = directory / f"inventory-{shard}.json"
        result_path = directory / f"result-{shard}.json"
        inventory = json.loads(inventory_path.read_text())
        if not isinstance(inventory, list) or not inventory:
            raise ValueError(f"shard {shard}: missing complete file inventory")
        paths = [relative(item["file"]) for item in inventory]
        if len(paths) != len(set(paths)):
            raise ValueError(f"shard {shard}: duplicate inventory entry")
        if expected is not None and expected != set(paths):
            raise ValueError(f"shard {shard}: discovery inventories disagree")
        expected = set(paths)
        report = json.loads(result_path.read_text())
        if (report.get("success") is not True or report.get("numFailedTests") != 0
                or report.get("numFailedTestSuites") != 0 or report.get("numPendingTestSuites") != 0):
            raise ValueError(f"shard {shard}: failed or unfinished tests/suites")
        files = report["testResults"]
        if not isinstance(files, list) or not files:
            raise ValueError(f"shard {shard}: empty result set")
        counts = Counter(passed=0, skipped=0, todo=0)
        for file in files:
            name = relative(file["name"])
            seen[name] += 1
            if file.get("status") != "passed" or file.get("message"):
                raise ValueError(f"shard {shard}: file failed: {name}")
            for case in file["assertionResults"]:
                status = case.get("status")
                if status not in {"passed", "skipped", "todo"} or case.get("failureMessages"):
                    raise ValueError(f"shard {shard}: failed or unfinished case in {name}")
                counts[status] += 1
        expected_counts = {"numPassedTests": counts["passed"], "numPendingTests": counts["skipped"],
                           "numTodoTests": counts["todo"], "numTotalTests": sum(counts.values())}
        if any(type(report.get(key)) is not int or report[key] != value for key, value in expected_counts.items()):
            raise ValueError(f"shard {shard}: case counts disagree with report summary")
        totals.update(counts)
        receipts.append({"shard": shard, "files": len(files), **dict(counts),
                         "inventory_sha256": hashlib.sha256(inventory_path.read_bytes()).hexdigest(),
                         "result_sha256": hashlib.sha256(result_path.read_bytes()).hexdigest()})
    if set(seen) != expected or any(count != 1 for count in seen.values()):
        raise ValueError(f"file partition mismatch: missing={sorted(expected - set(seen))}, "
                         f"unexpected={sorted(set(seen) - expected)}, duplicates={sorted(p for p, n in seen.items() if n != 1)}")
    return {"schema": 1, "status": "passed", "files": len(seen), **dict(totals),
            "shards": receipts, "verified_files": sorted(seen)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--shards", type=int, required=True)
    parser.add_argument("--tests-result", required=True)
    parser.add_argument("--contracts-result", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.shards < 1:
        parser.error("shards must be positive")
    summary = verify(args.directory, args.root, args.shards, args.tests_result, args.contracts_result)
    args.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(f"Verified {summary['files']} files exactly once: {summary['passed']} passed, "
          f"{summary['skipped']} skipped, {summary['todo']} todo across {args.shards} shards")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError) as error:
        print(f"CLI shard verification failed: {error}", file=sys.stderr)
        sys.exit(1)
