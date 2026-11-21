"""Shared fixture data for local contract tests and the disposable GCS check."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("desktop_publisher", ROOT / "scripts/publish-desktop-manifest.py")
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


def make_parts(directory, version, base_url, signer):
    directory.mkdir(parents=True, exist_ok=True)
    entries = {}
    for name, keys in publisher.PARTS.items():
        part = {}
        for key in sorted(keys):
            payload = f"Publication contract fixture: {version} {key}\n".encode()
            part[key] = dict(version=version, url=f"{base_url}/{key}",
                             size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
            if file_name := publisher.verification.SIGNED.get(key):
                part[key]["signature"] = signer.sign(payload, desktop_comment(file_name, version))
            (directory / key).write_bytes(payload)
        (directory / name).write_text(json.dumps(part))
        entries.update(part)
    return entries


def desktop_comment(file_name, version):
    return f"timestamp:1795200000\tfile:{file_name}\tdesktop-version:{version}"


class FixtureSigner:
    """A throwaway Ed25519 key that signs as Tauri does (minisign), so no test holds the release key."""

    def __init__(self, folder):
        self._folder = Path(folder)
        self._folder.mkdir(parents=True, exist_ok=True)
        self._private_key = self._folder / "key.pem"
        self._openssl("genpkey", "-algorithm", "ed25519", "-out", self._private_key)
        public = self._openssl("pkey", "-in", self._private_key, "-pubout", "-outform", "DER")[-32:]
        self.key_id = os.urandom(8)
        # minisign prints the key id as a little-endian number.
        self.public_key = _tauri_form(f"untrusted comment: minisign public key: {self.key_id[::-1].hex().upper()}",
                                      b"Ed" + self.key_id + public)

    def sign(self, data, comment, *, algorithm=b"ED", key_id=None):
        # ED signs the file's BLAKE2b-512; the legacy Ed signs the file itself.
        signature = self._ed25519(hashlib.blake2b(data).digest() if algorithm == b"ED" else data)
        global_signature = self._ed25519(signature + comment.encode())
        return _tauri_form("untrusted comment: signature from tauri secret key",
                           algorithm + (key_id or self.key_id) + signature,
                           f"trusted comment: {comment}", global_signature)

    def _ed25519(self, message):
        (self._folder / "message").write_bytes(message)
        return self._openssl("pkeyutl", "-sign", "-inkey", self._private_key, "-rawin", "-in", self._folder / "message")

    @staticmethod
    def _openssl(*argv):
        return subprocess.run(["openssl", *argv], check=True, capture_output=True, timeout=30).stdout


def _tauri_form(*lines):
    """The minisign text, each bytes line base64-encoded, then the whole text base64-encoded as Tauri stores it."""
    text = "".join((line if isinstance(line, str) else base64.b64encode(line).decode()) + "\n" for line in lines)
    return base64.b64encode(text.encode()).decode()


def artifact_upload_script(script_name, variable):
    """Exercise the actual helper AND upload invocation, without building an app."""
    source = (ROOT / "desktop/scripts" / script_name).read_text()
    function = "gcs_cp() {" + source.split("gcs_cp() {", 1)[1].split("\n}", 1)[0] + "\n}\n"
    # Windows uploads its three files in a loop, so its call is indented; the line runs the same alone.
    invocation = next(line.strip() for line in source.splitlines() if line.strip().startswith(f'gcs_cp "${variable}" '))
    return function + invocation + "\n"
