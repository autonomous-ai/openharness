"""Run the real Linux packager/uploader with fake tools: a build job packages, the release job uploads."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

TOOL = r"""
import json, os, sys
from pathlib import Path
root = Path(os.environ["FIXTURE"])
tool, args = Path(sys.argv[0]).name, sys.argv[1:]
with open(root / "calls.jsonl", "a") as log:
    log.write(json.dumps([tool, *args]) + "\n")
if tool == "uname":
    print("Linux" if args == ["-s"] else "x86_64")
elif tool == "curl":
    print("{}")
elif tool == "flutter":
    bundle = Path("build/linux/x64/release/bundle")
    bundle.mkdir(parents=True)
    (bundle / "harness").write_text("app")
    (bundle / "harness").chmod(0o755)
    (bundle / "harness.png").write_text("icon")
elif tool == "appimagetool":
    Path(args[-1]).write_text("appimage bytes")
elif tool == "sha256sum":
    print("a" * 64 + "  " + args[-1])
elif tool == "gcloud":
    if args[:2] == ["storage", "ls"]:
        sys.exit(1)
    if args[:2] == ["storage", "cp"] and args[-2].startswith("gs://"):
        sys.exit(1)
"""


class LinuxUploadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.desktop = self.root / "desktop"
        (self.desktop / "scripts").mkdir(parents=True)
        shutil.copy(ROOT / "desktop/scripts/upload-desktop-linux.sh", self.desktop / "scripts")
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for name in ("uname", "curl", "flutter", "appimagetool", "sha256sum", "gcloud"):
            (self.tools / name).write_text(f"#!{sys.executable}\n{TOOL}")
            (self.tools / name).chmod(0o755)
        self.appimage = self.desktop / "build/Harness-linux-x64-1.2.3.AppImage"
        self.env = dict(os.environ, PATH=f"{self.tools}{os.pathsep}/usr/bin{os.pathsep}/bin", FIXTURE=str(self.root),
                        TARGET_ARCH="x64", GCS_BUCKET="fixture-bucket", GCS_PATH="fixture/Harness-linux-x64.AppImage",
                        METADATA_PATH="fixture/.ci/1-1/linux-x64.json", APPIMAGETOOL=str(self.tools / "appimagetool"))

    def run_script(self, *args, **env):
        return subprocess.run(["bash", str(self.desktop / "scripts/upload-desktop-linux.sh"), "1.2.3", *args],
                              env=dict(self.env, **env), capture_output=True, text=True, timeout=30)

    def calls(self, tool):
        return [call[1:] for call in map(json.loads, (self.root / "calls.jsonl").read_text().splitlines())
                if call[0] == tool]

    def test_no_upload_packages_without_any_cloud_call(self):
        (self.tools / "gcloud").unlink()
        result = self.run_script("--no-upload")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.appimage.read_text(), "appimage bytes")
        self.assertEqual(self.calls("gcloud"), [])

    def test_upload_only_publishes_the_packaged_file_without_building(self):
        (self.tools / "flutter").unlink()
        self.appimage.parent.mkdir(parents=True)
        self.appimage.write_text("packaged by the build job")
        env = dict(self.env)
        env.pop("APPIMAGETOOL")
        result = subprocess.run(["bash", str(self.desktop / "scripts/upload-desktop-linux.sh"), "1.2.3", "--upload-only"],
                                env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        copies = [call for call in self.calls("gcloud") if call[:2] == ["storage", "cp"]]
        self.assertIn(str(self.appimage), copies[0])
        self.assertEqual(copies[0][-1], "gs://fixture-bucket/fixture/Harness-linux-x64.AppImage")
        self.assertEqual(copies[-1][-1], "gs://fixture-bucket/fixture/.ci/1-1/linux-x64.json")
        self.assertEqual(self.calls("appimagetool"), [])

    def test_upload_only_without_a_package_uploads_nothing(self):
        result = self.run_script("--upload-only")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AppImage missing", result.stderr)
        self.assertEqual([call for call in self.calls("gcloud") if call[:2] == ["storage", "cp"]], [])


if __name__ == "__main__":
    unittest.main()
