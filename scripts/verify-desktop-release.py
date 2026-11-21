#!/usr/bin/env python3
"""Verify all nine public Desktop downloads concurrently, without storing the binaries.

Uses the updater's Dart user agent, full SHA-256/size checks and curl's total
transfer deadline (a socket idle timeout alone does not bound a slow transfer).
Only reads public endpoints; never publishes or changes a manifest.

With --signed, checks Linux AppImages on disk against their Tauri signatures (<AppImage>.sig) and the key Harness
Device pins, before they are uploaded; it writes no receipt.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

KEYS = (
    "desktop-macos", "desktop-macos-dmg", "desktop-macos-arm64",
    "desktop-macos-arm64-dmg", "desktop-linux-x64", "desktop-linux-arm64",
    "desktop-windows-x64", "desktop-windows-arm64", "desktop-windows-installer",
)
MANIFEST = "https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/desktop/metadata.json"
USER_AGENT = "Dart/3.13 (dart:io)"
# curl's exit codes for a connection lost, not an answer: could not connect, partial file, TLS or
# handshake reset, empty reply, send error, receive error. A reset on one of nine downloads failed
# 1.3.65's publish after its manifest was already live.
CONNECTION_DROPPED = frozenset({7, 18, 35, 52, 55, 56})
DOWNLOAD_TRIES = 3
RETRY_PAUSE_SECONDS = 2
ROOT = Path(__file__).resolve().parents[1]
# Fixed per architecture, never taken from a URL: a signature's file: field must name exactly this.
SIGNED = {"desktop-linux-x64": "Harness-linux-x64.AppImage", "desktop-linux-arm64": "Harness-linux-arm64.AppImage"}
# A real signature is about 450 characters; Desktop refuses a longer text before decoding it, and so does the release.
SIGNATURE_LIMIT = 4096
ED25519_DER_PREFIX = bytes.fromhex("302a300506032b6570032100")


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


class ConnectionDropped(ValueError):
    """The network dropped the download. Nothing was said about the file, so it is worth another try."""


def download(entry, timeout):
    """The file's size and digest. A timeout is not retried: it would break the deadline this check promises."""
    digest = hashlib.sha256()
    size = 0
    with subprocess.Popen(
        curl_command(entry["url"], timeout) + ["--max-filesize", str(entry["size"])],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as process:
        try:
            for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
            error = process.stderr.read().decode(errors="replace").strip()
            code = process.wait()
            if code in CONNECTION_DROPPED:
                raise ConnectionDropped(f"download failed: {error}")
            if code != 0:
                raise ValueError(f"download failed: {error}")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
    return size, digest


def verify_artifact(item, timeout):
    key, entry = item
    started = time.monotonic()
    result = {field: entry[field] for field in ("version", "url", "sha256", "size")}
    result.update(key=key, started_at=utc_now(), status="failed")
    digest = hashlib.sha256()
    size = 0
    try:
        for attempt in range(1, DOWNLOAD_TRIES + 1):
            try:
                size, digest = download(entry, timeout)
                break
            except ConnectionDropped:
                if attempt == DOWNLOAD_TRIES:
                    raise
                time.sleep(attempt * RETRY_PAUSE_SECONDS)
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


class SignatureRefused(ValueError):
    """Why a signature is refused, one of Desktop's six reasons, so a log line holds no signature text."""

    def __init__(self, reason):
        super().__init__(f"signature refused ({reason})")
        self.reason = reason


def pinned_public_key():
    """The key Harness Device pins, and Desktop with it: read from the app's config, so the release keeps no copy."""
    return json.loads((ROOT / "device-app" / "src-tauri" / "tauri.conf.json").read_text())["plugins"]["updater"]["pubkey"]


def parse_signature(text):
    """Tauri's form, the .minisig text base64-encoded: its key id, file signature, trusted comment and global signature."""
    if text is None or text == "":
        raise SignatureRefused("missing")
    try:
        if not isinstance(text, str) or len(text) > SIGNATURE_LIMIT:
            raise ValueError
        lines = base64.b64decode(text, validate=True).decode().split("\n")
        if lines[-1] == "":
            lines.pop()
        untrusted, signature, trusted, global_signature = lines
        signature = base64.b64decode(signature, validate=True)
        global_signature = base64.b64decode(global_signature, validate=True)
        # ED alone: the legacy Ed signs the whole file, not its BLAKE2b-512.
        if (not untrusted.startswith("untrusted comment: ") or not trusted.startswith("trusted comment: ")
                or len(signature) != 74 or signature[:2] != b"ED" or len(global_signature) != 64):
            raise ValueError
    except ValueError:
        raise SignatureRefused("malformed") from None
    return signature[2:10], signature[10:], trusted[len("trusted comment: "):], global_signature


def _public_key(text):
    """Tauri's form of a minisign public key (Ed, key id, Ed25519 key): its key id and Ed25519 key."""
    key = base64.b64decode(base64.b64decode(text, validate=True).split(b"\n")[1], validate=True)
    return key[2:10], key[10:]


def ed25519_verify(public_key, message, signature):
    """OpenSSL 3's command line checks Ed25519, so the release adds no dependency; LibreSSL's pkeyutl has no -rawin."""
    version = subprocess.run(["openssl", "version"], capture_output=True, text=True, timeout=30).stdout
    if not version.startswith("OpenSSL 3"):
        raise RuntimeError("OpenSSL 3 is required to check signatures")
    with tempfile.TemporaryDirectory() as folder:
        folder = Path(folder)
        pem = base64.b64encode(ED25519_DER_PREFIX + public_key).decode()
        (folder / "key.pem").write_text(f"-----BEGIN PUBLIC KEY-----\n{pem}\n-----END PUBLIC KEY-----\n")
        (folder / "message").write_bytes(message)
        (folder / "signature").write_bytes(signature)
        return subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", folder / "key.pem", "-rawin",
             "-in", folder / "message", "-sigfile", folder / "signature"],
            capture_output=True, timeout=30,
        ).returncode == 0


def _verified(signature, digest, public_key, comment_holds):
    """Desktop's order, so each refusal has one reason: a genuine signature for another file is comment, not file."""
    signature_key_id, file_signature, comment, global_signature = parse_signature(signature)
    key_id, key = _public_key(pinned_public_key() if public_key is None else public_key)
    if signature_key_id != key_id:
        raise SignatureRefused("key")
    if not ed25519_verify(key, file_signature + comment.encode(), global_signature):
        raise SignatureRefused("global")
    if not comment_holds(comment.split("\t")):
        raise SignatureRefused("comment")
    if not ed25519_verify(key, digest, file_signature):
        raise SignatureRefused("file")
    return comment


def verify_minisign(signature, digest, public_key=None):
    """The trusted comment of a signature the key made over a file of this BLAKE2b-512 digest."""
    return _verified(signature, digest, public_key, lambda fields: True)


def check_signature(signature, digest, file_name, version, public_key=None):
    """A Desktop AppImage's signature: its comment names this file and this Desktop version, each field matched whole."""
    _verified(signature, digest, public_key, lambda fields: (
        f"file:{file_name}" in fields and f"desktop-version:{version}" in fields
        # Harness Device's updater reads only a version: field, so it never takes a signature without one.
        and not any(field.startswith("version:") for field in fields)))


def blake2b_of(path):
    digest = hashlib.blake2b()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def check_signed(version, paths):
    """Each AppImage against its .sig and the pinned key, all of them reported before the exit status."""
    failed = False
    for path in paths:
        sig = path.with_name(path.name + ".sig")
        try:
            check_signature(sig.read_text(errors="replace") if sig.exists() else None, blake2b_of(path), path.name, version)
            print(f"{path.name}: signature verified")
        except SignatureRefused as error:
            print(f"error: {path.name}: {error}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


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
    parser.add_argument("--jobs", type=int, choices=range(1, len(KEYS) + 1), default=3)
    parser.add_argument("--timeout", type=int, choices=range(1, 301), default=90, metavar="SECONDS")
    parser.add_argument("--signed", nargs="+", type=Path, metavar="PATH")
    args = parser.parse_args(argv)
    if args.signed:
        if any(path.name not in SIGNED.values() for path in args.signed):
            parser.error(f"--signed takes {' and '.join(SIGNED.values())}")
        return check_signed(args.version, args.signed)
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
