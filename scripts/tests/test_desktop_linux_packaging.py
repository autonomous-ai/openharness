"""The Linux build packages with no credential, and the upload runs with no key, against fake tools."""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "desktop/scripts/package-desktop-linux.sh"
UPLOAD = ROOT / "desktop/scripts/upload-desktop-linux.sh"
VERSION = "1.2.3"
SCRATCH = "harness/desktop/.ci/77-1"
CDN = "https://cdn.example.test"
ARCHES = ("x64", "arm64")

# Records each call, and keeps a copy of what each `storage cp` copied under the destination's name.
FAKE_GCLOUD = """#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_ROOT/gcloud.log"
[ "$1 $2" = "storage cp" ] || exit 91
shift 2
while [ "$#" -gt 2 ]; do shift; done
cp "$1" "$FAKE_ROOT/uploaded-$(basename "$2")"
"""


def minisign_text(arch):
    return (f"untrusted comment: signature from minisign secret key\nRUQ{arch}\n"
            f"trusted comment: timestamp:1\tfile:Harness-linux-{arch}.AppImage\tdesktop-version:{VERSION}\nZmFrZQ==\n")


class UploadTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="linux-upload-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.release = self.root / "linux-release"
        self.release.mkdir()
        for arch in ARCHES:
            name = f"Harness-linux-{arch}.AppImage"
            data = f"AppImage bytes for {arch}\n".encode()
            (self.release / name).write_bytes(data)
            (self.release / f"{name}.sha256").write_text(f"{hashlib.sha256(data).hexdigest()}  {name}\n")
            (self.release / f"{name}.sig").write_text(base64.b64encode(minisign_text(arch).encode()).decode() + "\n")
        fakes = self.root / "bin"
        fakes.mkdir()
        (fakes / "gcloud").write_text(FAKE_GCLOUD)
        (fakes / "gcloud").chmod(0o755)
        self.env = {name: value for name, value in os.environ.items()
                    if name not in ("ARTIFACT_PREFIX", "SCRATCH_PREFIX", "CDN_ASSET_BASE_URL", "GCS_BUCKET")}
        self.env.update(PATH=f"{fakes}:{os.environ['PATH']}", FAKE_ROOT=str(self.root), GCS_BUCKET="fixture-bucket",
                        ARTIFACT_PREFIX=f"harness/desktop/{VERSION}", SCRATCH_PREFIX=SCRATCH, CDN_ASSET_BASE_URL=CDN)

    def run_upload(self, **env):
        return subprocess.run(["bash", str(UPLOAD), VERSION, str(self.release)], env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=30)

    def calls(self):
        log = self.root / "gcloud.log"
        return log.read_text().splitlines() if log.exists() else []

    def assert_refused(self, result, reason):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(reason, result.stderr)
        self.assertIn("nothing was uploaded", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_uploads_both_appimages_create_only_and_writes_each_part_with_its_signature(self):
        result = self.run_upload()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 4)
        for call in calls:
            self.assertIn("--if-generation-match=0", call)
        for arch in ARCHES:
            name = f"Harness-linux-{arch}.AppImage"
            upload = next(call for call in calls if call.endswith(f"gs://fixture-bucket/harness/desktop/{VERSION}/{name}"))
            self.assertIn("--cache-control=public, max-age=31536000, immutable", upload)
            data = (self.release / name).read_bytes()
            self.assertEqual((self.root / f"uploaded-{name}").read_bytes(), data)
            part_call = next(call for call in calls if call.endswith(f"gs://fixture-bucket/{SCRATCH}/linux-{arch}.json"))
            self.assertIn("--cache-control=no-cache, no-store, must-revalidate", part_call)
            self.assertIn("--content-type=application/json", part_call)
            part = json.loads((self.root / f"uploaded-linux-{arch}.json").read_text())
            self.assertEqual(part, {f"desktop-linux-{arch}": {
                "version": VERSION,
                "url": f"{CDN}/harness/desktop/{VERSION}/{name}",
                "sha256": hashlib.sha256(data).hexdigest(),
                "size": len(data),
                "signature": (self.release / f"{name}.sig").read_text().strip(),
            }})
        # The parts follow the files, so a failed upload leaves no part naming bytes that are not there.
        self.assertTrue(all(call.endswith(".AppImage") for call in calls[:2]), calls)

    def test_an_appimage_whose_sums_do_not_match_uploads_nothing(self):
        name = "Harness-linux-arm64.AppImage"
        cases = {
            "changed byte": lambda: (self.release / name).write_bytes(b"AppImage bytes for arm65\n"),
            # Sums that hold for the other file: `sha256sum --check` alone would pass them.
            "sums of another file": lambda: shutil.copy(self.release / "Harness-linux-x64.AppImage.sha256",
                                                        self.release / f"{name}.sha256"),
            "no sums": lambda: (self.release / f"{name}.sha256").unlink(),
        }
        for case, change in cases.items():
            with self.subTest(case=case):
                self.setUp()
                change()
                self.assert_refused(self.run_upload(), f"{name} does not match its sums")

    def test_a_missing_or_two_line_signature_uploads_nothing(self):
        def sig():  # each case's own fresh folder
            return self.release / "Harness-linux-x64.AppImage.sig"
        cases = {
            "missing": lambda: sig().unlink(),
            "two lines": lambda: sig().write_text(sig().read_text() * 2),
            "not base64": lambda: sig().write_text("not base64!\n"),
            "empty": lambda: sig().write_text(""),
        }
        for case, change in cases.items():
            with self.subTest(case=case):
                self.setUp()
                change()
                self.assert_refused(self.run_upload(), "Harness-linux-x64.AppImage.sig is not one line of base64")

    def test_a_prefix_that_is_no_releases_candidates_or_promotion_checks_uploads_nothing(self):
        for prefix in ("harness/desktop", "harness/desktop/1.2.4", "harness/staging/desktop/1.2.3",
                       "harness/desktop/1.2.3/../cli", "harness/desktop-candidates/1-1-short"):
            with self.subTest(prefix=prefix):
                self.assert_refused(self.run_upload(ARTIFACT_PREFIX=prefix), f"ARTIFACT_PREFIX '{prefix}'")
        with self.subTest(scratch="metadata"):
            self.assert_refused(self.run_upload(SCRATCH_PREFIX="harness/desktop/metadata.json"), "SCRATCH_PREFIX")


class PackageTest(unittest.TestCase):
    def test_the_build_script_holds_no_credential_and_names_no_bucket(self):
        self.assertTrue(PACKAGE.is_file(), PACKAGE)
        text = PACKAGE.read_text()
        for word in ("gcloud", "gs://", "curl", "secrets", "TAURI_SIGNING"):
            self.assertNotIn(word, text)

    @unittest.skipUnless(sys.platform.startswith("linux"), "flutter build linux runs on Linux only")
    def test_the_build_script_packages_the_bundle_with_its_sums(self):
        root = Path(tempfile.mkdtemp(prefix="linux-package-"))
        self.addCleanup(shutil.rmtree, root, True)
        desktop = root / "desktop"
        (desktop / "scripts").mkdir(parents=True)
        shutil.copy(PACKAGE, desktop / "scripts" / PACKAGE.name)
        arch = "arm64" if platform.machine() in ("aarch64", "arm64") else "x64"
        fakes = root / "bin"
        fakes.mkdir()
        # flutter writes the bundle where `flutter build linux` puts it; appimagetool archives the AppDir it is given.
        (fakes / "flutter").write_text(f"""#!/bin/sh
[ "$*" = "build linux --release" ] || exit 91
mkdir -p build/linux/{arch}/release/bundle
printf 'binary' > build/linux/{arch}/release/bundle/harness
chmod +x build/linux/{arch}/release/bundle/harness
printf 'icon' > build/linux/{arch}/release/bundle/harness.png
""")
        (fakes / "appimagetool").write_text("""#!/bin/sh
[ "$1" = --appimage-extract-and-run ] || exit 92
tar -C "$2" -cf "$3" .
""")
        for tool in ("flutter", "appimagetool"):
            (fakes / tool).chmod(0o755)
        env = dict(os.environ, PATH=f"{fakes}:{os.environ['PATH']}", APPIMAGETOOL=str(fakes / "appimagetool"))
        result = subprocess.run(["bash", str(desktop / "scripts" / PACKAGE.name), VERSION], env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        out = desktop / "build/linux-release"
        name = f"Harness-linux-{arch}.AppImage"
        self.assertEqual(sorted(path.name for path in out.iterdir()), [name, f"{name}.sha256"])
        check = subprocess.run(["sha256sum", "--check", f"{name}.sha256"], cwd=out, capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stdout + check.stderr)
        stamped = subprocess.run(["tar", "-xOf", str(out / name), "./usr/bin/version.txt"], capture_output=True, text=True)
        self.assertEqual(stamped.stdout, f"{VERSION}\n")


if __name__ == "__main__":
    unittest.main()
