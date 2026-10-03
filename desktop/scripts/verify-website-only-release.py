#!/usr/bin/env python3
"""Reject a website-only tag that would change the deployed Flutter bundle."""
import json
import re
import subprocess
import sys


def verify(manifest, published):
    version = manifest.get("version", "")
    if (not re.fullmatch(r"\d+\.\d+\.\d+", version)
            or not re.fullmatch(r"[a-f0-9]{40}", manifest.get("sourceCommit", ""))
            or not re.fullmatch(r"[a-f0-9]{64}", manifest.get("sha256", ""))
            or manifest.get("baseHref") != "/harness-web/"
            or manifest.get("archiveUrl") != (
                f"https://github.com/autonomous-ai/openharness/releases/download/"
                f"v{version}_web/harness-web-{version}.tar.gz")):
        raise ValueError("Invalid pinned web release manifest")
    for field in ("version", "sourceCommit", "baseHref", "apiUrl"):
        if manifest.get(field) != published.get(field):
            raise ValueError(f"Pinned web {field} differs from production; pin the deployed release first")
    return version


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ("live", "manifest"):
        raise SystemExit("usage: verify-website-only-release.py COMMIT live|manifest")
    manifest = json.loads(subprocess.check_output(
        ["git", "show", f"{sys.argv[1]}:website/harness-web-release.json"], timeout=15))
    published = manifest
    if sys.argv[2] == "live":
        # Use the same HTTP client as the other release scripts. The production
        # edge rejects urllib's default user agent even for this public manifest.
        published = json.loads(subprocess.check_output([
            "curl", "--fail", "--silent", "--show-error", "--max-time", "20",
            "--header", "Cache-Control: no-cache",
            "https://harness.autonomous.ai/harness-web/release.json"], timeout=25))
    print(verify(manifest, published))


if __name__ == "__main__":
    main()
