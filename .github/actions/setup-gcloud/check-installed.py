#!/usr/bin/env python3
"""Bound the optional runner SDK probe; unknown installations use normal setup."""
import json
import os
from pathlib import Path
import re
import subprocess
import time

# Conservative floor: the Ubuntu runner SDK exercised by our real GCS publication
# contract. Older installations take the existing latest-version install path.
MIN_VERSION = (586, 0, 0)
# A cold runner can spend just over five seconds starting its existing SDK.
# Killing that healthy probe made two jobs install another copy for 20-24s.
# Keep the check bounded, but allow cold startup to finish before falling back.
PROBE_TIMEOUT_SECONDS = 10


def installed_version():
    try:
        result = subprocess.run(
            ["gcloud", "version", "--format=json"],
            check=True, capture_output=True, text=True, timeout=PROBE_TIMEOUT_SECONDS,
        )
        data = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    version = data.get("Google Cloud SDK") if isinstance(data, dict) else None
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}", version):
        return None
    return version if tuple(map(int, version.split("."))) >= MIN_VERSION else None


def main():
    started = time.monotonic()
    version = installed_version()
    elapsed = time.monotonic() - started
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"reusable={'true' if version else 'false'}\n")
    # Never forward raw SDK stdout/stderr into logs or Actions output commands.
    if version:
        print(f"Reusing Google Cloud CLI {version} (probe {elapsed:.2f}s)")
    else:
        print(f"Installing Google Cloud CLI: no working runner installation at or above 586.0.0 (probe {elapsed:.2f}s)")


if __name__ == "__main__":
    main()
