#!/usr/bin/env python3
"""Wait for one Desktop tag/commit to publish and pass its automated verification."""
import argparse
import json
import re
import subprocess
import sys
import time


def gh_json(args, timeout):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "GitHub lookup failed")
    return json.loads(result.stdout)


def watch(tag, sha, timeout=1800, appear_timeout=180):
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+_desktop", tag) or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("supply a Desktop release tag and its full commit SHA")
    started = time.monotonic()
    deadline = started + timeout
    run = None
    previous = None
    while time.monotonic() < deadline:
        remaining = max(1, min(30, deadline - time.monotonic()))
        if run is None:
            runs = gh_json([
                "run", "list", "--workflow", "release-desktop.yml", "--event", "push",
                "--branch", tag, "--commit", sha, "--limit", "5",
                "--json", "databaseId,headSha,headBranch,url",
            ], remaining)
            matches = [item for item in runs if item["headSha"] == sha and item["headBranch"] == tag]
            if matches:
                run = matches[0]  # gh returns newest first, including a rerun of the exact source.
                print(f"Watching {tag} at {sha[:12]}: {run['url']}", flush=True)
            elif time.monotonic() - started >= appear_timeout:
                raise TimeoutError(f"no release-desktop.yml run appeared for {tag} at {sha}")
        if run is not None:
            detail = gh_json([
                "run", "view", str(run["databaseId"]),
                "--json", "headSha,headBranch,status,conclusion,jobs",
            ], max(1, min(30, deadline - time.monotonic())))
            if detail["headSha"] != sha or detail["headBranch"] != tag:
                raise RuntimeError("release run does not match the requested tag/commit")
            state = ", ".join(f"{job['name']}: {job['conclusion'] or job['status']}" for job in detail["jobs"])
            if state != previous:
                print(state or detail["status"], flush=True)
                previous = state
            if detail["status"] == "completed":
                if detail["conclusion"] != "success":
                    raise RuntimeError(f"release {detail['conclusion']}: {run['url']}")
                # Older releases used a separate verify job. Newer ones verify
                # inside publish's lock, so require that exact step to pass.
                verified = any(
                    job["conclusion"] == "success" and (
                        job["name"] == "verify" or (
                            job["name"] == "publish" and any(
                                step["name"] == "Verify all public artifacts as the updater" and step["conclusion"] == "success"
                                for step in job.get("steps", [])
                            )
                        )
                    ) for job in detail["jobs"]
                )
                if not verified:
                    raise RuntimeError("run has no successful public-download verification; use verify-desktop-release.py for older releases")
                release_url = run["url"].split("/actions/runs/", 1)[0] + "/releases/tag/" + tag
                print(f"Published and verified: {release_url}", flush=True)
                return run
        time.sleep(max(0, min(10, deadline - time.monotonic())))
    raise TimeoutError(f"release did not complete within {timeout}s; inspect " + (run["url"] if run else tag))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--sha", required=True)
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    try:
        watch(args.tag, args.sha, args.timeout)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
