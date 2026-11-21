"""The release's check of a Tauri signature, against throwaway keys and the live Device 0.1.11 signature.

FixtureSigner (OpenSSL) writes the minisign form Tauri writes; the live signature pins that format and the key Harness
Device ships. OpenSSL 3 or later must be first on PATH (on a Mac, Homebrew's openssl@3).
"""
import base64
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import unittest
from unittest import mock

import desktop_publication_fixture as fixture

SCRIPT = Path(__file__).resolve().parents[1] / "verify-desktop-release.py"
spec = importlib.util.spec_from_file_location("verify_desktop_signature", SCRIPT)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)

PAYLOAD = b"Harness signature fixture\n" * 40
DIGEST = hashlib.blake2b(PAYLOAD).digest()
FILE = "Harness-linux-x64.AppImage"
DEVICE_COMMENT = "timestamp:1795200000\tfile:Harness-Device-linux-x64.AppImage\tversion:0.1.12"
# platforms.darwin-aarch64.signature of https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/device/metadata.json
# at 0.1.11, and `openssl dgst -blake2b512` of that archive, both read on 2026-11-21.
LIVE_DEVICE_SIGNATURE = (
    "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSaUgzdG96TDg1Unl4S1lkTE9TbDV2aXArdkVB"
    "R0tNeWd2MnJjYVFDSzZ4a2ppSWM4ZVBSVHQyaUdqeGxET21xSERCdmloMnRZc1lqODRiUitvYTlJaGFibFZxbG8xMmc4PQp0cnVzdGVkIGNv"
    "bW1lbnQ6IHRpbWVzdGFtcDoxNzk1MTU2ODM5CWZpbGU6SGFybmVzcyBEZXZpY2UuYXBwLnRhci5negl2ZXJzaW9uOjAuMS4xMQoxZTJBZjh1"
    "OGZHNlpVY3pvYUo0VGMyVytYbXRaNFpEcmxZV3NxTTM0MTRqQkU3OU80cUMyNmxtTDlidStaQjZFK3FpaEVTcmJnUmdaTnJFTjM0WXFEdz09"
    "Cg=="
)
LIVE_DEVICE_DIGEST = bytes.fromhex(
    "66175b2291420a04be465626bd0dcd7a6851b71fc64e1643d49eac3336f93f0d"
    "678637ac35aea5f315acdba90083d84b0e25dafa7d0d173df98cf3bf0f7ac159"
)


def decoded_lines(signature):
    return base64.b64decode(signature).decode().split("\n")


def encoded(lines, separator="\n"):
    return base64.b64encode(separator.join(lines).encode()).decode()


class TauriSignatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.folder = Path(folder.name)
        cls.signer = fixture.FixtureSigner(cls.folder / "signer")
        cls.other = fixture.FixtureSigner(cls.folder / "other")
        cls.good = cls.signer.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.3"))

    def check(self, signature, digest=DIGEST, file_name=FILE, version="1.2.3"):
        return verify.check_signature(signature, digest, file_name, version, public_key=self.signer.public_key)

    def assertRefused(self, reason, signature, **expected):
        with self.assertRaises(verify.SignatureRefused) as caught:
            self.check(signature, **expected)
        self.assertEqual(caught.exception.reason, reason)
        self.assertEqual(str(caught.exception), f"signature refused ({reason})")

    def test_a_signature_made_with_the_key_passes(self):
        self.assertIsNone(self.check(self.good))
        self.assertEqual(verify.verify_minisign(self.good, DIGEST, public_key=self.signer.public_key),
                         "timestamp:1795200000\tfile:Harness-linux-x64.AppImage\tdesktop-version:1.2.3")

    def test_a_changed_digest_refuses_file(self):
        self.assertRefused("file", self.good, digest=hashlib.blake2b(PAYLOAD + b"!").digest())

    def test_another_key_refuses_key(self):
        self.assertRefused("key", self.other.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.3")))

    def test_another_keys_signature_carrying_this_key_id_refuses_global(self):
        forged = self.other.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.3"), key_id=self.signer.key_id)
        self.assertRefused("global", forged)

    def test_a_broken_global_signature_refuses_global(self):
        lines = decoded_lines(self.good)
        broken = bytearray(base64.b64decode(lines[3]))
        broken[0] ^= 1
        lines[3] = base64.b64encode(bytes(broken)).decode()
        self.assertRefused("global", encoded(lines))

    def test_an_edited_trusted_comment_refuses_global(self):
        lines = decoded_lines(self.good)
        lines[2] = lines[2].replace("1.2.3", "1.2.4")
        self.assertRefused("global", encoded(lines), version="1.2.4")

    def test_a_device_signature_offered_for_a_desktop_file_refuses_comment(self):
        # Signed over the Device's own bytes: the comment is checked before the file, as Desktop checks it.
        device = self.signer.sign(b"Harness Device AppImage\n", DEVICE_COMMENT)
        for version in ("0.1.12", "1.2.3"):
            with self.subTest(version=version):
                self.assertRefused("comment", device, version=version)

    def test_a_desktop_comment_carrying_a_version_field_refuses_comment(self):
        # Harness Device's updater reads only a version: field; the release never publishes one it could accept.
        both = self.signer.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.3") + "\tversion:1.2.3")
        self.assertRefused("comment", both)

    def test_look_alike_fields_refuse_comment(self):
        signed = {
            "file extended": self.signer.sign(PAYLOAD, fixture.desktop_comment(FILE + ".old", "1.2.3")),
            "version extended": self.signer.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.30")),
        }
        for case, signature in signed.items():
            with self.subTest(case=case):
                self.assertRefused("comment", signature)
        for case, expected in {"file a prefix": dict(file_name="Harness-linux-x64.App"),
                               "version a prefix": dict(version="1.2")}.items():
            with self.subTest(case=case):
                self.assertRefused("comment", self.good, **expected)

    def test_the_legacy_Ed_algorithm_refuses_malformed(self):
        self.assertRefused("malformed", self.signer.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.3"), algorithm=b"Ed"))

    def test_no_signature_refuses_missing(self):
        for signature in (None, ""):
            with self.subTest(signature=signature):
                self.assertRefused("missing", signature)

    def test_garbage_refuses_malformed(self):
        lines = decoded_lines(self.good)
        long = self.signer.sign(PAYLOAD, fixture.desktop_comment(FILE, "1.2.3") + "\tnote:" + "x" * 3000)
        self.assertGreater(len(long), 4096)
        cases = {
            "not base64": "not base64!",
            "one word": base64.b64encode(b"hello").decode(),
            "three lines": encoded(lines[:3]),
            "five lines": encoded(lines[:4] + ["one more"]),
            "CRLF line ends": encoded(lines, "\r\n"),
            "over 4096 characters": long,
            "not text": 123,
        }
        for case, signature in cases.items():
            with self.subTest(case=case):
                self.assertRefused("malformed", signature)

    def test_the_pinned_key_verifies_the_live_device_signature(self):
        self.assertEqual(verify.verify_minisign(LIVE_DEVICE_SIGNATURE, LIVE_DEVICE_DIGEST),
                         "timestamp:1795156839\tfile:Harness Device.app.tar.gz\tversion:0.1.11")

    def test_the_live_device_signature_is_no_desktop_signature(self):
        with self.assertRaises(verify.SignatureRefused) as caught:
            verify.check_signature(LIVE_DEVICE_SIGNATURE, LIVE_DEVICE_DIGEST, FILE, "0.1.11")
        self.assertEqual(caught.exception.reason, "comment")

    def openssl_saying(self, version):
        """PATH with an openssl first whose `version` says version, and which hands every other command to the real one."""
        tools = Path(tempfile.mkdtemp(dir=self.folder))
        real = shutil.which("openssl")
        (tools / "openssl").write_text(
            f'#!/bin/sh\nif [ "$1" = version ]; then echo {shlex.quote(version)}; exit 0; fi\nexec {shlex.quote(real)} "$@"\n')
        (tools / "openssl").chmod(0o755)
        return mock.patch.dict(os.environ, PATH=f"{tools}{os.pathsep}{os.environ['PATH']}")

    def test_an_openssl_that_is_not_openssl_3_or_later_is_refused(self):
        # LibreSSL's pkeyutl has no -rawin, and OpenSSL before 3 checks no Ed25519 from its command line.
        for version in ("LibreSSL 3.3.6", "OpenSSL 1.1.1w  11 Sep 2023"):
            with self.subTest(version=version), self.openssl_saying(version):
                with self.assertRaisesRegex(RuntimeError, r"^OpenSSL 3 or later is required to check signatures$"):
                    self.check(self.good)

    def test_openssl_4_checks_signatures(self):
        with self.openssl_saying("OpenSSL 4.0.0 1 Apr 2026 (Library: OpenSSL 4.0.0 1 Apr 2026)"):
            self.assertIsNone(self.check(self.good))
            self.assertRefused("file", self.good, digest=hashlib.blake2b(PAYLOAD + b"!").digest())


class SignedCommandTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        folder = tempfile.TemporaryDirectory()
        cls.addClassCleanup(folder.cleanup)
        cls.folder = Path(folder.name)
        cls.signer = fixture.FixtureSigner(cls.folder / "signer")
        cls.appimages = []
        for arch in ("x64", "arm64"):
            appimage = cls.folder / f"Harness-linux-{arch}.AppImage"
            appimage.write_bytes(PAYLOAD + arch.encode())
            appimage.with_name(appimage.name + ".sig").write_text(
                cls.signer.sign(appimage.read_bytes(), fixture.desktop_comment(appimage.name, "1.2.3")))
            cls.appimages.append(str(appimage))

    def run_main(self, *argv):
        output = io.StringIO()
        receipt = self.folder / "receipt.json"
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = verify.main(["1.2.3", "--receipt", str(receipt), *argv])
        self.assertFalse(receipt.exists())
        return code, output.getvalue()

    def test_an_appimage_signed_by_another_key_than_the_pinned_one_fails(self):
        code, output = self.run_main("--signed", self.appimages[0])
        self.assertEqual(code, 1)
        self.assertIn("error: Harness-linux-x64.AppImage: signature refused (key)", output)

    def test_appimages_signed_with_the_pinned_key_for_their_own_name_pass(self):
        with mock.patch.object(verify, "pinned_public_key", return_value=self.signer.public_key):
            code, output = self.run_main("--signed", *self.appimages)
        self.assertEqual(code, 0, output)
        self.assertIn("Harness-linux-x64.AppImage: signature verified", output)
        self.assertIn("Harness-linux-arm64.AppImage: signature verified", output)

    def test_an_appimage_with_no_signature_file_fails_and_the_other_is_still_checked(self):
        unsigned = self.folder / "unsigned" / "Harness-linux-arm64.AppImage"
        unsigned.parent.mkdir()
        unsigned.write_bytes(PAYLOAD)
        with mock.patch.object(verify, "pinned_public_key", return_value=self.signer.public_key):
            code, output = self.run_main("--signed", str(unsigned), self.appimages[0])
        self.assertEqual(code, 1)
        self.assertIn("error: Harness-linux-arm64.AppImage: signature refused (missing)", output)
        self.assertIn("Harness-linux-x64.AppImage: signature verified", output)

    def test_a_file_that_is_no_linux_appimage_of_the_release_is_refused(self):
        # The expected file: name comes from the release's own list, never from what was handed in.
        output = io.StringIO()
        with contextlib.redirect_stderr(output), self.assertRaises(SystemExit) as caught:
            verify.main(["1.2.3", "--signed", str(self.folder / "Harness-macos.zip")])
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("Harness-linux-x64.AppImage", output.getvalue())

    def test_the_command_takes_signed_files_and_no_key(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises(SystemExit):
            verify.main(["--help"])
        options = re.findall(r"--[a-z-]+", output.getvalue())
        self.assertIn("--signed", options)
        self.assertEqual([option for option in options if "key" in option or "pub" in option], [])


if __name__ == "__main__":
    unittest.main()
