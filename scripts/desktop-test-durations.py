#!/usr/bin/env python3
"""Refresh scripts/desktop-test-durations.json, the per-file times Desktop CI shards are balanced by (task #3458).

Give it green CI runs: it downloads each run's Desktop shard artifacts with `gh`, measures every VM test file from its
first test start to its last test end in the JSON reporter log, and writes each file's median over the runs. Three
recent runs from different runners is a good sample; runner speed varies by a fifth.

    python3 scripts/desktop-test-durations.py --run 42062947953 --run 42062373039 --run 42061777210

Artifacts already on disk (`gh run download RUN --pattern 'desktop-shard-*' --dir DIR`) are read with --from RUN=DIR,
which spends none of the account's artifact download allowance again.
"""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile

OUTPUT = Path(__file__).with_name("desktop-test-durations.json")
RUNS = "https://github.com/autonomous-ai/openharness/actions/runs/"
DESCRIPTION = ("Per-file durations of Desktop VM tests (seconds, median over the runs named), from each shard's JSON reporter "
               "log: a file's first test start to its last test end. scripts/test-desktop.py splits shards by them; refresh "
               "with scripts/desktop-test-durations.py.")


def log_durations(log, desktop):
    """Seconds per desktop-relative test file in one reporter log."""
    paths, suite_of, first, last = {}, {}, {}, {}
    for line in log.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # Flutter also writes non-JSON build/progress output.
        if not isinstance(event, dict) or not isinstance(event.get("time"), (int, float)):
            continue
        kind, at = event.get("type"), event["time"]
        if kind == "suite":
            paths[event["suite"]["id"]] = event["suite"]["path"]
        elif kind == "testStart":
            suite = event["test"]["suiteID"]
            suite_of[event["test"]["id"]] = suite
            first.setdefault(suite, at)
        elif kind == "testDone" and event.get("testID") in suite_of:
            suite = suite_of[event["testID"]]
            last[suite] = max(last.get(suite, at), at)
    durations = {}
    for suite, path in paths.items():
        if suite in first and suite in last:
            relative = Path(path).relative_to(desktop).as_posix() if Path(path).is_relative_to(desktop) else path
            durations[relative] = round((last[suite] - first[suite]) / 1000, 1)
    return durations


def run_durations(folder):
    """Seconds per file in one run: every shard receipt under [folder] and the reporter logs beside it."""
    durations = {}
    receipts = sorted(Path(folder).rglob("receipt.json"))
    for receipt in receipts:
        desktop = Path(json.loads(receipt.read_text())["desktop_root"])
        for log in sorted(receipt.parent.glob("desktop-vm*.log")):
            durations.update(log_durations(log, desktop))
    if not durations:
        raise ValueError(f"no Desktop shard logs under {folder}")
    return durations


def durations_document(runs):
    """The durations file for {run id: {file: seconds}}: each file's median over the runs that measured it."""
    seen = {}
    for measured in runs.values():
        for path, seconds in measured.items():
            seen.setdefault(path, []).append(seconds)
    return {"schema": 1, "description": DESCRIPTION, "sourceRuns": [RUNS + run for run in runs],
            "files": {path: round(statistics.median(values), 1) for path, values in sorted(seen.items())}}


def download(run, folder):
    """A run's Desktop shard artifacts, through `gh` (signed in to the repository)."""
    subprocess.run(["gh", "run", "download", run, "--pattern", "desktop-shard-*", "--dir", str(folder)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", action="append", default=[], help="a green CI run id to download; give three or more")
    parser.add_argument("--from", dest="local", action="append", default=[], metavar="RUN=DIR",
                        help="a run whose shard artifacts are already downloaded into DIR")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    if not args.run and not args.local:
        parser.error("give --run or --from")
    with tempfile.TemporaryDirectory(prefix="desktop-durations.") as folder:
        runs = {}
        for item in args.local:
            run, _, path = item.partition("=")
            if not run or not path:
                parser.error("--from takes RUN=DIR")
            runs[run] = run_durations(Path(path))
        for run in args.run:
            target = Path(folder) / run
            download(run, target)
            runs[run] = run_durations(target)
    document = durations_document(runs)
    args.output.write_text(json.dumps(document, indent=1) + "\n")
    print(f"{len(document['files'])} files, {sum(document['files'].values()):.0f}s in all, from {len(runs)} runs: {args.output}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"desktop durations error: {error}", file=sys.stderr)
        sys.exit(1)
