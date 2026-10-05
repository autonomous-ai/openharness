#!/usr/bin/env python3
"""Publish one complete Desktop version using a generation-conditional GCS write.

Builds may overlap. A late older build, incomplete platform set, corrupt live
manifest or concurrent writer must fail without replacing the live manifest.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

# Use the same six-entry/schema contract as public download verification.
spec = importlib.util.spec_from_file_location("desktop_verification", Path(__file__).with_name("verify-desktop-release.py"))
verification = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verification)

PARTS = {
    "macos-intel.json": {"desktop-macos", "desktop-macos-dmg"},
    "macos-apple-silicon.json": {"desktop-macos-arm64", "desktop-macos-arm64-dmg"},
    "linux-x64.json": {"desktop-linux-x64"},
    "linux-arm64.json": {"desktop-linux-arm64"},
}


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value):
        raise ValueError(f"invalid Desktop version: {value!r}")
    return tuple(map(int, value.split(".")))


def gcloud(*args):
    result = subprocess.run(["gcloud", *args], capture_output=True, text=True, timeout=90)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "gcloud failed")
    return result.stdout


def read_live(uri, allow_initialize=False):
    if not re.fullmatch(r"gs://[a-z0-9._-]+/[A-Za-z0-9._/-]+", uri) or ".." in uri.split("/"):
        raise ValueError("manifest must be a literal gs://bucket/object path")
    try:
        description = json.loads(gcloud("storage", "objects", "describe", uri, "--format=json"))
    except RuntimeError as error:
        # Permission/transport failures are never treated as an absent manifest.
        if allow_initialize and re.search(r"\b404\b", str(error)):
            return {}, "0"
        raise
    generation = str(description.get("generation", ""))
    if not re.fullmatch(r"[1-9][0-9]*", generation):
        raise ValueError("GCS returned no valid manifest generation")
    # Read exactly the generation described; a change in between fails closed.
    live = json.loads(gcloud("storage", "cat", f"{uri}#{generation}"))
    if not isinstance(live, dict):
        raise ValueError("live manifest must be an object")
    return live, generation


def require_new_version(version, live, allow_initialize=False):
    requested = version_tuple(version)
    found = False
    for key, entry in live.items():
        if not key.startswith("desktop-"):
            continue
        found = True
        if not isinstance(entry, dict):
            raise ValueError(f"{key}: invalid live entry")
        current = entry.get("version")
        if requested <= version_tuple(current):
            raise ValueError(f"{version} is not newer than live {key} {current}; this release is superseded or already published")
    if not found and not allow_initialize:
        raise ValueError("live manifest has no Desktop versions; initialization requires --allow-initialize")


def read_parts(directory, version):
    files = {path.name for path in directory.glob("*.json")}
    if files != set(PARTS):
        raise ValueError(f"expected four platform manifests; missing={sorted(set(PARTS) - files)}, extra={sorted(files - set(PARTS))}")
    entries = {}
    for name, keys in PARTS.items():
        part = json.loads((directory / name).read_text())
        if not isinstance(part, dict) or set(part) != keys:
            raise ValueError(f"{name}: expected exactly {sorted(keys)}")
        entries.update(part)
    verification.entries_for_version(entries, version)
    return entries


def write_manifest(uri, manifest, generation):
    with tempfile.TemporaryDirectory(prefix="desktop-manifest-") as folder:
        path = Path(folder) / "metadata.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n")
        gcloud("storage", "cp", str(path), uri, f"--if-generation-match={generation}",
               "--content-type=application/json", "--cache-control=no-cache, no-store, must-revalidate")


def publish(uri, version, parts, allow_initialize=False):
    entries = read_parts(parts, version)
    live, generation = read_live(uri, allow_initialize)
    require_new_version(version, live, allow_initialize)
    merged = dict(live, **entries)
    write_manifest(uri, merged, generation)
    return merged


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("manifest")
    parser.add_argument("--parts", type=Path)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--allow-initialize", action="store_true", help="only for an explicitly new scratch manifest")
    args = parser.parse_args(argv)
    if not args.check_only and args.parts is None:
        parser.error("publication requires --parts")
    try:
        version_tuple(args.version)
        if args.check_only:
            live, _ = read_live(args.manifest, args.allow_initialize)
            require_new_version(args.version, live, args.allow_initialize)
            print(f"Desktop {args.version} is newer than the live manifest")
        else:
            publish(args.manifest, args.version, args.parts, args.allow_initialize)
            print(f"Published all six Desktop {args.version} entries to {args.manifest}")
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
