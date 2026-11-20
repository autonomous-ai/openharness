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
# The CDN's bot rules answer 403 to Python's default User-Agent ("Python-urllib/3.x").
USER_AGENT = "harness-device-release"
FILES = ("Harness-Device.dmg", "Harness-Device.app.tar.gz", "Harness-Device.app.tar.gz.sig")
DMG, ARCHIVE = FILES[:2]
# Each build job's files, every update beside its .sig: each job hashes its own, and publish checks each artifact.
PARTS = {
    "macos": FILES,
    "windows": ("Harness-Device-windows-x64-setup.exe", "Harness-Device-windows-x64-setup.exe.sig",
                "Harness-Device-windows-arm64-setup.exe", "Harness-Device-windows-arm64-setup.exe.sig"),
    "linux-x64": ("Harness-Device-linux-x64.AppImage", "Harness-Device-linux-x64.AppImage.sig"),
    "linux-arm64": ("Harness-Device-linux-arm64.AppImage", "Harness-Device-linux-arm64.AppImage.sig"),
}
# The parts a release carries. Temporary: the first Windows and Linux release makes "all" the only choice.
PLATFORMS = {"macos": ("macos",), "all": tuple(PARTS)}
# Tauri's key, Desktop's key, the website's key and the file of each Windows and Linux update: unlike the universal Mac
# archive, each arch has a file of its own, which is also the installer a person downloads. The website reads only
# installer keys, device-<os>-<arch>-<package>, as it reads device-macos-dmg.
UPDATES = (
    ("windows-x86_64", "device-windows-x64", "device-windows-x64-exe", "Harness-Device-windows-x64-setup.exe"),
    ("windows-aarch64", "device-windows-arm64", "device-windows-arm64-exe", "Harness-Device-windows-arm64-setup.exe"),
    ("linux-x86_64", "device-linux-x64", "device-linux-x64-appimage", "Harness-Device-linux-x64.AppImage"),
    ("linux-aarch64", "device-linux-arm64", "device-linux-arm64-appimage", "Harness-Device-linux-arm64.AppImage"),
)
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


def release_files(platforms):
    """The files of a release of platforms, "macos" or "all", part by part."""
    return [name for part in PLATFORMS[platforms] for name in PARTS[part]]


def file_sums(folder, names):
    """sha256 and size of each of the files named."""
    sums = {}
    for name in names:
        data = (Path(folder) / name).read_bytes()
        sums[name] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
    return sums


def check_sums(folder, path, part):
    names = PARTS[part]
    expected, actual = json.loads(Path(path).read_text()), file_sums(folder, names)
    if expected != actual:
        differ = [name for name in names if not isinstance(expected, dict) or expected.get(name) != actual[name]]
        raise ValueError(f"{', '.join(differ) or 'the file list'} in {folder} differs from {path}")


def file_entries(version, folder, base_url, platforms="macos"):
    """What the manifest says of this build: its version, the update archive for both Macs, and an entry in Desktop's
    shape for the archive and the dmg, once per Mac; with all, each Windows and Linux file as its arch's update and in
    Desktop's shape, under Desktop's key and the website's."""
    parse(version)
    folder = Path(folder)
    sums = file_sums(folder, release_files(platforms))

    def update(name):
        return {"url": f"{base_url}/{version}/{name}", "signature": (folder / f"{name}.sig").read_text().strip()}

    def entry(name):
        return {"version": version, "url": f"{base_url}/{version}/{name}", **sums[name]}

    mac = update(ARCHIVE)
    # The app is universal, so the arm64 pair names the same files as the other pair.
    entries = {"version": version, "platforms": {"darwin-aarch64": mac, "darwin-x86_64": dict(mac)},
               "device-macos": entry(ARCHIVE), "device-macos-dmg": entry(DMG),
               "device-macos-arm64": entry(ARCHIVE), "device-macos-arm64-dmg": entry(DMG)}
    if platforms == "all":
        for key, desktop_key, installer_key, name in UPDATES:
            entries["platforms"][key] = update(name)
            entries[desktop_key] = entry(name)
            entries[installer_key] = entry(name)
    return entries


def updates(manifest):
    """The manifest's platforms object, or an empty one when it holds none."""
    platforms = manifest.get("platforms")
    return platforms if isinstance(platforms, dict) else {}


def differing(manifest, entries):
    """The keys of entries that manifest holds otherwise, each update on its own."""
    live = updates(manifest)
    return ([f"platforms.{key}" for key, value in entries["platforms"].items() if live.get(key) != value] +
            [key for key, value in entries.items() if key != "platforms" and manifest.get(key) != value])


def build_manifest(version, folder, notes, pub_date, base_url, platforms="macos"):
    """Tauri's static update manifest, which installed apps read, plus each file's entry in Desktop's shape."""
    if not PUB_DATE.fullmatch(pub_date):
        raise ValueError(f"pub_date {pub_date!r} must be YYYY-MM-DDTHH:MM:SSZ")
    datetime.strptime(pub_date, "%Y-%m-%dT%H:%M:%SZ")  # and a real date: the updater reads it as RFC 3339
    # file_entries repeats version, which keeps its first place, ahead of notes and pub_date.
    return {"version": version, "notes": notes.rstrip("\n"), "pub_date": pub_date,
            **file_entries(version, folder, base_url, platforms)}


def gcloud(*args):
    result = subprocess.run(["gcloud", *args], capture_output=True, text=True, timeout=GCLOUD_TIMEOUT)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "gcloud failed")
    return result.stdout


def publish(version, folder, notes, pub_date, platforms="macos"):
    """Upload this build and point the live manifest at it; on any failure the live manifest stays as it was."""
    manifest = build_manifest(version, folder, notes, pub_date, CDN_BASE, platforms)
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
        current = json.loads(text)
        # Tauri's manifest has one version: Windows' and Linux's apps would take this one's with their last files,
        # signed for another version, and fail every check until a release of every platform.
        if platforms == "macos" and any(key.startswith(("windows-", "linux-")) for key in updates(current)):
            raise ValueError("Windows and Linux are live: release with --platforms all")
        if version == live:
            # A rerun after the manifest was written (verify failed, or gcloud gave up on a write that landed): this
            # build is live, so the run goes on to verify it. Another build must never go out under its version.
            if differing(current, file_entries(version, folder, CDN_BASE, platforms)):
                raise ValueError(f"{version} is already published with other files; release a new version")
            return current
    if parse(version) <= parse(live):
        raise ValueError(f"{version} is not greater than {live}, the live version")
    files = release_files(platforms)
    sums = file_sums(folder, files)
    with tempfile.TemporaryDirectory(prefix="device-release-") as temp:
        for name in files:
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
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
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


def verify(version, folder, manifest_url=ORIGIN_MANIFEST, base_url=CDN_BASE, tries=3, pause=5.0, platforms="macos"):
    """The public manifest names this build, and each update file and the dmg it names download as this build's."""
    expected = file_entries(version, folder, base_url, platforms)
    data = fetch(manifest_url, MANIFEST_LIMIT + 1, 20)
    if len(data) > MANIFEST_LIMIT:
        raise ValueError(f"{manifest_url} is larger than {MANIFEST_LIMIT} bytes")
    manifest = json.loads(data)
    if not isinstance(manifest, dict):
        raise ValueError(f"{manifest_url} is not a manifest")
    # Nothing of the manifest's text goes into a message: whoever can write the bucket chose it.
    differ = differing(manifest, expected)
    if differ:
        raise ValueError(f"the {differ[0]} in {manifest_url} differs from this build's")
    # Equal entries put every URL it names under base_url/<version>/, so nothing else is fetched.
    sums = file_sums(folder, release_files(platforms))
    named = [(manifest["platforms"]["darwin-aarch64"]["url"], ARCHIVE), (manifest["device-macos-dmg"]["url"], DMG)]
    if platforms == "all":
        named += [(manifest["platforms"][key]["url"], name) for key, *_, name in UPDATES]
    for url, name in named:
        download_matches(url, sums[name], tries, pause)


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

    step = commands.add_parser("sums", help="sha256 and size of one part's files, written or compared")
    step.add_argument("--dir", type=Path, required=True)
    step.add_argument("--part", choices=tuple(PARTS), default="macos")
    output = step.add_mutually_exclusive_group(required=True)
    output.add_argument("--out", type=Path)
    output.add_argument("--check", type=Path)

    build_step = commands.add_parser("build", help="the manifest, from the release's files")
    publish_step = commands.add_parser("publish", help="upload the release's files, then write the live manifest")
    verify_step = commands.add_parser("verify", help="the public manifest and downloads against the release's files")
    for step in (build_step, publish_step, verify_step):
        step.add_argument("--version", required=True)
        step.add_argument("--dir", type=Path, required=True)
        step.add_argument("--platforms", choices=tuple(PLATFORMS), default="macos")
    for step in (build_step, publish_step):
        step.add_argument("--notes-file", type=Path, required=True)
        step.add_argument("--pub-date", required=True, help="YYYY-MM-DDTHH:MM:SSZ")
    build_step.add_argument("--base-url", required=True)
    build_step.add_argument("--out", type=Path, required=True)
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
                args.out.write_text(json.dumps(file_sums(args.dir, PARTS[args.part]), indent=2) + "\n")
            else:
                check_sums(args.dir, args.check, args.part)
        elif args.command == "build":
            manifest = build_manifest(args.version, args.dir, args.notes_file.read_text(), args.pub_date, args.base_url,
                                      args.platforms)
            args.out.write_text(json.dumps(manifest, indent=2) + "\n")
        elif args.command == "publish":
            manifest = publish(args.version, args.dir, args.notes_file.read_text(), args.pub_date, args.platforms)
            print(json.dumps(manifest, indent=2))
        else:
            verify(args.version, args.dir, platforms=args.platforms)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired, http.client.HTTPException) as error:
        # One line, whatever gcloud or Git printed.
        print("ERROR " + " ".join(str(error).split()), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
