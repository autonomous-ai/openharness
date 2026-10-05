#!/usr/bin/env python3
"""Verify all six public Desktop downloads concurrently, without storing the binaries.

Uses the updater's Dart user agent, full SHA-256/size checks and curl's total
transfer deadline (a socket idle timeout alone does not bound a slow transfer).
Only reads public endpoints; never publishes or changes a manifest.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlsplit

KEYS = (
    "desktop-macos", "desktop-macos-dmg", "desktop-macos-arm64",
    "desktop-macos-arm64-dmg", "desktop-linux-x64", "desktop-linux-arm64",
)
MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json"
USER_AGENT = "Dart/3.13 (dart:io)"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def curl_command(url, timeout):
    parsed = urlsplit(url)
    # Loopback HTTP permits real local-server regression tests. Public downloads
    # and redirects must use HTTPS; never pass manifest text through a shell.
    loopback = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "::1")
    if (parsed.scheme != "https" and not loopback) or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
        raise ValueError(f"invalid public download URL: {url!r}")
    return [
        "curl", "--fail", "--location", "--silent", "--show-error",
        "--connect-timeout", str(min(15, timeout)), "--max-time", str(timeout),
        "--proto", "=http,https" if loopback else "=https", "--proto-redir", "=https",
        "--user-agent", USER_AGENT, "--url", url,
    ]


def read_manifest(url, timeout):
    result = subprocess.run(
        curl_command(url, timeout) + ["--max-filesize", "1048576"],
        capture_output=True, timeout=timeout + 2,
    )
    if result.returncode:
        raise ValueError("manifest download failed: " + result.stderr.decode(errors="replace").strip())
    return json.loads(result.stdout), hashlib.sha256(result.stdout).hexdigest()


def entries_for_version(manifest, version, keys=KEYS):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("expected version must be X.Y.Z")
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    entries = []
    for key in keys:
        entry = manifest.get(key)
        if not isinstance(entry, dict) or entry.get("version") != version:
            raise ValueError(f"{key}: missing entry or version differs from {version}")
        if type(entry.get("size")) is not int or entry["size"] <= 0:
            raise ValueError(f"{key}: size must be a positive integer")
        if not isinstance(entry.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", entry["sha256"]):
            raise ValueError(f"{key}: invalid SHA-256")
        if not isinstance(entry.get("url"), str):
            raise ValueError(f"{key}: missing URL")
        curl_command(entry["url"], 1)  # Validate every entry before starting downloads.
        entries.append((key, entry))
    return entries


def verify_artifact(item, timeout):
    key, entry = item
    started = time.monotonic()
    result = {field: entry[field] for field in ("version", "url", "sha256", "size")}
    result.update(key=key, started_at=utc_now(), status="failed")
    digest = hashlib.sha256()
    size = 0
    try:
        with subprocess.Popen(
            curl_command(entry["url"], timeout) + ["--max-filesize", str(entry["size"])],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) as process:
            try:
                for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                    size += len(chunk)
                    digest.update(chunk)
                error = process.stderr.read().decode(errors="replace").strip()
                if process.wait() != 0:
                    raise ValueError(f"download failed: {error}")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
        if size != entry["size"]:
            raise ValueError(f"size mismatch: expected {entry['size']}, received {size}")
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError("SHA-256 mismatch")
        result["status"] = "passed"
    except (OSError, ValueError) as error:
        result["error"] = str(error)
    result.update(actual_size=size, actual_sha256=digest.hexdigest(),
                  finished_at=utc_now(), duration_seconds=round(time.monotonic() - started, 3))
    print(f"{key}: {result['status']} ({result['duration_seconds']}s)" +
          (f" — {result['error']}" if "error" in result else ""), flush=True)
    return result


def verify(version, manifest_url=MANIFEST, jobs=3, timeout=90):
    started = time.monotonic()
    receipt = dict(version=version, manifest_url=manifest_url, started_at=utc_now(),
                   source_sha=os.environ.get("GITHUB_SHA"), run_id=os.environ.get("GITHUB_RUN_ID"),
                   status="failed", artifacts=[])
    try:
        manifest, receipt["manifest_sha256"] = read_manifest(manifest_url, min(20, timeout))
        entries = entries_for_version(manifest, version)
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            receipt["artifacts"] = list(pool.map(lambda item: verify_artifact(item, timeout), entries))
        if all(item["status"] == "passed" for item in receipt["artifacts"]):
            receipt["status"] = "passed"
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        receipt["error"] = str(error)
    receipt.update(finished_at=utc_now(), duration_seconds=round(time.monotonic() - started, 3))
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--manifest-url", default=MANIFEST)
    parser.add_argument("--receipt", type=Path, default=Path(".harness/desktop-release-verification.json"))
    parser.add_argument("--jobs", type=int, choices=range(1, 7), default=3)
    parser.add_argument("--timeout", type=int, choices=range(1, 301), default=90, metavar="SECONDS")
    args = parser.parse_args(argv)
    receipt = verify(args.version, args.manifest_url, args.jobs, args.timeout)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2) + "\n")
    message = f"Desktop {args.version}: {receipt['status']} in {receipt['duration_seconds']}s"
    if receipt.get("error"):
        message += f" — {receipt['error']}"
    print(message)
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as stream:
            stream.write(message + "\n\n| Download | Result | Seconds |\n|---|---|---|\n")
            for item in receipt["artifacts"]:
                stream.write(f"| {item['key']} | {item['status']} | {item['duration_seconds']} |\n")
    return 0 if receipt["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
