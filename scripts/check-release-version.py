#!/usr/bin/env python3
"""Fail before a build/upload if a release would reuse or downgrade a version."""
import json
import re
import sys
from pathlib import Path


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        raise ValueError(f"invalid release version: {value!r}")
    return tuple(map(int, value.split(".")))


def require_new_version(requested, manifest):
    if not isinstance(manifest, dict):
        raise ValueError("live manifest must be an object")
    current = manifest.get("version")
    if version_tuple(requested) <= version_tuple(current):
        raise ValueError(f"{requested} is not newer than published {current}; bump the version before releasing")


if __name__ == "__main__":
    try:
        requested, manifest_path = sys.argv[1:]
        require_new_version(requested, json.loads(Path(manifest_path).read_text()))
    except (ValueError, OSError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
