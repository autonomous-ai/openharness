#!/usr/bin/env python3
"""The release rules of Harness Device: the next version, which runs may build, the update manifest, its publication
and the check of the public copy.

The device app's own copy of these rules, not an import of Desktop's scripts. Every failure is one line on stderr
starting "ERROR " and exit 1. Only publish writes anything outside this machine, and only through gcloud.
"""
import argparse
from datetime import datetime
import hashlib
import http.client
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.request

BUCKET = "gs://s3-autonomous-upgrade-3/harness/device"
CDN_BASE = "https://cdn.autonomous.ai/harness/device"
ORIGIN_MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json"
FILES = ("Harness-Device.dmg", "Harness-Device.app.tar.gz", "Harness-Device.app.tar.gz.sig")
DMG, ARCHIVE, SIGNATURE = FILES
# A release's files never change, so caches may keep them; the manifest must be read fresh every time.
ASSET_CACHE = "public, max-age=31536000, immutable"
VERSION = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")
TAG = re.compile(rf"v({VERSION.pattern})_device")
PUB_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
MANIFEST_LIMIT = 1 << 20
# The dmg upload is the slowest call.
GCLOUD_TIMEOUT = 300


def parse(version):
    """(X, Y, Z) of a plain X.Y.Z, compared as numbers."""
    if not VERSION.fullmatch(version):
        raise ValueError(f"version {version!r} must be X.Y.Z")
    return tuple(int(part) for part in version.split("."))


def live_version(text):
    """The manifest's version, or None when the text is not a manifest with a plain X.Y.Z version."""
    try:
        manifest = json.loads(text)
    except ValueError:
        return None
    version = manifest.get("version") if isinstance(manifest, dict) else None
    return version if isinstance(version, str) and VERSION.fullmatch(version) else None


def next_version(tags, live, minor=False, explicit=None, allow_no_manifest=False):
    """The next version: the patch bump of max(highest v*_device tag, live), .99 rolling to the next minor at .1."""
    released = sorted((parse(match.group(1)), tag) for tag in tags if (match := TAG.fullmatch(tag)))
    last_tag = released[-1][1] if released else ""
    if live is None:
        # A public read cannot tell a missing manifest from a refused one, so only the first release may go without.
        if not allow_no_manifest:
            raise ValueError(f"could not read the live manifest at {ORIGIN_MANIFEST} "
                             "(--allow-no-manifest is for the first release only)")
        if last_tag:
            raise ValueError(f"{last_tag} exists, so this is not the first release: "
                             f"the live manifest at {ORIGIN_MANIFEST} must be read")
        live = "0.0.0"
    major, minor_part, patch = max(parse(live), released[-1][0] if released else (0, 0, 0))
    if explicit is not None:
        version = explicit
    elif minor or patch >= 99:
        version = f"{major}.{minor_part + 1}.1"
    else:
        version = f"{major}.{minor_part}.{patch + 1}"
    # Every installed app refuses a version not above the one it runs, and the release would still look fine.
    if parse(version) <= parse(live):
        raise ValueError(f"{version} is not greater than {live}, the live version")
    return {"version": version, "last_tag": last_tag, "live": live}


def check_ref(version, ref, publish):
    """A release runs only on its own tag, a candidate only on main."""
    parse(version)
    if publish not in ("true", "false"):
        raise ValueError(f"publish must be true or false, not {publish!r}")
    allowed = f"refs/tags/v{version}_device" if publish == "true" else "refs/heads/main"
    if ref != allowed:
        raise ValueError(f"with publish={publish}, {version} runs only on {allowed}, not {ref!r}")


def check_on_main(commit, repo="."):
    """The run's commit is origin/main or before it: a signed build of unreviewed code must not exist."""
    # Checked before Git runs, so nothing but a full commit name can reach its command line.
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError(f"commit {commit!r} must be 40 lowercase hex characters")
    result = subprocess.run(["git", "-C", repo, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"],
                            capture_output=True, text=True, timeout=30)
    if result.returncode == 1:
        raise ValueError(f"{commit} is not on origin/main")
    if result.returncode:
        raise ValueError(f"{commit} could not be checked against origin/main: {result.stderr.strip() or 'git failed'}")


def file_sums(folder):
    """sha256 and size of each of the three files."""
    sums = {}
    for name in FILES:
        data = (Path(folder) / name).read_bytes()
        sums[name] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    return sums


def check_sums(folder, path):
    expected, actual = json.loads(Path(path).read_text()), file_sums(folder)
    if expected != actual:
        differ = [name for name in FILES if not isinstance(expected, dict) or expected.get(name) != actual[name]]
        raise ValueError(f"{', '.join(differ) or 'the file list'} in {folder} differs from {path}")


def file_entries(version, folder, base_url):
    """What the manifest says of this build: its version, the update archive for both Macs, and the dmg."""
    parse(version)
    folder = Path(folder)
    sums = file_sums(folder)
    update = {"url": f"{base_url}/{version}/{ARCHIVE}", "signature": (folder / SIGNATURE).read_text().strip()}
    return {"version": version, "platforms": {"darwin-aarch64": update, "darwin-x86_64": dict(update)},
            "dmg": {"url": f"{base_url}/{version}/{DMG}", **sums[DMG]}}


def build_manifest(version, folder, notes, pub_date, base_url):
    """Tauri's static update manifest, plus the dmg the website links to."""
    if not PUB_DATE.fullmatch(pub_date):
        raise ValueError(f"pub_date {pub_date!r} must be YYYY-MM-DDTHH:MM:SSZ")
    datetime.strptime(pub_date, "%Y-%m-%dT%H:%M:%SZ")  # and a real date: the updater reads it as RFC 3339
    entries = file_entries(version, folder, base_url)
    return {"version": version, "notes": notes.rstrip("\n"), "pub_date": pub_date,
            "platforms": entries["platforms"], "dmg": entries["dmg"]}


def gcloud(*args):
    result = subprocess.run(["gcloud", *args], capture_output=True, text=True, timeout=GCLOUD_TIMEOUT)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "gcloud failed")
    return result.stdout


def publish(version, folder, notes, pub_date):
    """Upload this build and point the live manifest at it; on any failure the live manifest stays as it was."""
    manifest = build_manifest(version, folder, notes, pub_date, CDN_BASE)
    live_uri = f"{BUCKET}/metadata.json"
    try:
        description = json.loads(gcloud("storage", "objects", "describe", live_uri, "--format=json"))
    except RuntimeError as error:
        # Only a 404 is the first release: a refused or failed read must never pass for an empty bucket.
        if not re.search(r"\b404\b", str(error)):
            raise
        generation, live = "0", "0.0.0"
    else:
        generation = str(description.get("generation", ""))
        if not re.fullmatch(r"[1-9][0-9]*", generation):
            raise ValueError(f"{live_uri} has no generation")
        # Exactly the generation described: a manifest written in between fails this read, or the write below.
        text = gcloud("storage", "cat", f"{live_uri}#{generation}")
        live = live_version(text)
        if live is None:
            raise ValueError(f"{live_uri}#{generation} has no plain X.Y.Z version")
        if version == live:
            # A rerun after the manifest was written (verify failed, or gcloud gave up on a write that landed): this
            # build is live, so the run goes on to verify it. Another build must never go out under its version.
            current = json.loads(text)
            if any(current.get(key) != value for key, value in file_entries(version, folder, CDN_BASE).items()):
                raise ValueError(f"{version} is already published with other files; release a new version")
            return current
    if parse(version) <= parse(live):
        raise ValueError(f"{version} is not greater than {live}, the live version")
    sums = file_sums(folder)
    with tempfile.TemporaryDirectory(prefix="device-release-") as temp:
        for name in FILES:
            target = f"{BUCKET}/{version}/{name}"
            gcloud("storage", "cp", "--no-clobber", f"--cache-control={ASSET_CACHE}", str(Path(folder) / name), target)
            # No-clobber keeps what an earlier run of this version left: the manifest may name it only if it is
            # this build's, or every app would fail the signature check.
            back = Path(temp) / name
            gcloud("storage", "cp", target, str(back))
            if hashlib.sha256(back.read_bytes()).hexdigest() != sums[name]["sha256"]:
                raise ValueError(f"{target} differs from this build's {name}; the manifest was not written")
        path = Path(temp) / "metadata.json"
        path.write_text(json.dumps(manifest, indent=2) + "\n")
        # Only over the generation read above (0: only where none exists), so a concurrent release fails, never
        # overwrites.
        gcloud("storage", "cp", str(path), live_uri, f"--if-generation-match={generation}",
               "--content-type=application/json", "--cache-control=no-cache")
    return manifest


def fetch(url, limit, timeout):
    """At most limit bytes of url, within about timeout seconds in all (a socket timeout alone bounds no transfer)."""
    deadline = time.monotonic() + timeout
    body = bytearray()
    with urllib.request.urlopen(url, timeout=timeout) as response:
        while len(body) < limit:
            # read1 returns what one socket read brings; read waits for all it asked for, past the deadline.
            chunk = response.read1(min(1 << 20, limit - len(body)))
            if not chunk:
                break
            body += chunk
            if time.monotonic() > deadline:
                raise TimeoutError(f"{url} took more than {timeout} s")
    return bytes(body)


def download_matches(url, expected, tries, pause):
    """url downloads as expected (sha256 and size), within tries attempts pause seconds apart."""
    for attempt in range(tries):
        if attempt:
            time.sleep(pause)
        try:
            # One byte more than expected is enough to tell a longer file.
            data = fetch(url, expected["size"] + 1, 120)
        except (OSError, http.client.HTTPException) as error:
            problem = f"could not be downloaded ({error})"
            continue
        if {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)} == expected:
            return
        problem = "differs from this build's file"
    raise ValueError(f"{url} {problem}, after {tries} tries")


def verify(version, folder, manifest_url=ORIGIN_MANIFEST, base_url=CDN_BASE, tries=3, pause=5.0):
    """The public manifest names this build, and the archive and the dmg it names download as this build's."""
    expected = file_entries(version, folder, base_url)
    data = fetch(manifest_url, MANIFEST_LIMIT + 1, 20)
    if len(data) > MANIFEST_LIMIT:
        raise ValueError(f"{manifest_url} is larger than {MANIFEST_LIMIT} bytes")
    manifest = json.loads(data)
    if not isinstance(manifest, dict):
        raise ValueError(f"{manifest_url} is not a manifest")
    # Nothing of the manifest's text goes into a message: whoever can write the bucket chose it.
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise ValueError(f"the {key} in {manifest_url} differs from this build's")
    # Equal entries put every URL it names under base_url/<version>/, so nothing else is fetched.
    sums = file_sums(folder)
    download_matches(manifest["platforms"]["darwin-aarch64"]["url"], sums[ARCHIVE], tries, pause)
    download_matches(manifest["dmg"]["url"], sums[DMG], tries, pause)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        sys.exit(f"ERROR {message}")  # a usage error is one ERROR line and exit 1, as every other failure


def parser():
    parser = Parser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)

    step = commands.add_parser("next", help="the next version")
    step.add_argument("--tags", type=Path, required=True, help="the output of git tag -l")
    step.add_argument("--manifest", type=Path, help="the live manifest; left out when it could not be read")
    step.add_argument("--minor", action="store_true")
    step.add_argument("--allow-no-manifest", action="store_true", help="the first release only")
    step.add_argument("version", nargs="?", help="X.Y.Z instead of the bump")

    step = commands.add_parser("ref", help="whether a run may proceed: its ref, and its commit on origin/main")
    step.add_argument("version", metavar="VERSION")
    step.add_argument("git_ref", metavar="GIT_REF")
    step.add_argument("publish", metavar="PUBLISH", help="true or false")
    step.add_argument("commit", metavar="COMMIT", help="40 lowercase hex characters")

    step = commands.add_parser("sums", help="sha256 and size of the three files, written or compared")
    step.add_argument("--dir", type=Path, required=True)
    output = step.add_mutually_exclusive_group(required=True)
    output.add_argument("--out", type=Path)
    output.add_argument("--check", type=Path)

    build_step = commands.add_parser("build", help="the manifest, from the three files")
    publish_step = commands.add_parser("publish", help="upload the three files, then write the live manifest")
    for step in (build_step, publish_step):
        step.add_argument("--version", required=True)
        step.add_argument("--dir", type=Path, required=True)
        step.add_argument("--notes-file", type=Path, required=True)
        step.add_argument("--pub-date", required=True, help="YYYY-MM-DDTHH:MM:SSZ")
    build_step.add_argument("--base-url", required=True)
    build_step.add_argument("--out", type=Path, required=True)

    step = commands.add_parser("verify", help="the public manifest and downloads against the three files")
    step.add_argument("--version", required=True)
    step.add_argument("--dir", type=Path, required=True)
    return parser


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "next":
            live = live_version(args.manifest.read_bytes()) if args.manifest else None
            # Read, so something is live: only a manifest that could not be read may be the first release's.
            if args.manifest and live is None:
                raise ValueError(f"the live manifest at {ORIGIN_MANIFEST} has no readable X.Y.Z version")
            result = next_version(args.tags.read_text().split(), live, args.minor, args.version, args.allow_no_manifest)
            for key, value in result.items():
                print(f"{key}={value}")
        elif args.command == "ref":
            check_ref(args.version, args.git_ref, args.publish)
            check_on_main(args.commit)
        elif args.command == "sums":
            if args.out:
                args.out.write_text(json.dumps(file_sums(args.dir), indent=2) + "\n")
            else:
                check_sums(args.dir, args.check)
        elif args.command == "build":
            manifest = build_manifest(args.version, args.dir, args.notes_file.read_text(), args.pub_date, args.base_url)
            args.out.write_text(json.dumps(manifest, indent=2) + "\n")
        elif args.command == "publish":
            manifest = publish(args.version, args.dir, args.notes_file.read_text(), args.pub_date)
            print(json.dumps(manifest, indent=2))
        else:
            verify(args.version, args.dir)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, http.client.HTTPException) as error:
        # One line, whatever gcloud or Git printed.
        print("ERROR " + " ".join(str(error).split()), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
