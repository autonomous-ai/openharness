"""Run the real variant builder with fake macOS tools: every build is signed ad hoc."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]

TOOL = r"""
import os, sys
from pathlib import Path
tool, args = Path(sys.argv[0]).name, sys.argv[1:]
if tool == "uname":
    print("Darwin")
elif tool == "flutter":
    Path(os.environ["FIXTURE"], "flutter-sign-identity").write_text(os.environ.get("FLUTTER_XCODE_CODE_SIGN_IDENTITY", "unset"))
    contents = Path("build/macos/Build/Products/Release/Harness.app/Contents")
    contents.mkdir(parents=True)
    contents.joinpath("Info.plist").write_text('<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>')
elif tool == "plutil":
    print({"CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "10203"}[args[1]])
elif tool == "codesign" and "-dv" in args:
    print(os.environ["FIXTURE_SIGNATURE"], file=sys.stderr)
"""


class VariantBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.desktop = self.root / "desktop"
        (self.desktop / "scripts").mkdir(parents=True)
        shutil.copy(ROOT / "desktop/scripts/publish-macos-variant.sh", self.desktop / "scripts")
        tools = self.root / "tools"
        tools.mkdir()
        for name in ("uname", "flutter", "plutil", "lipo", "codesign"):
            (tools / name).write_text(f"#!{sys.executable}\n{TOOL}")
            (tools / name).chmod(0o755)
        self.env = dict(os.environ, PATH=f"{tools}{os.pathsep}{os.environ['PATH']}", FIXTURE=str(self.root))

    def build(self, signature):
        return subprocess.run(["bash", str(self.desktop / "scripts/publish-macos-variant.sh"), "apple-silicon", "1.2.3",
                               "--build-only"], env=dict(self.env, FIXTURE_SIGNATURE=signature),
                              capture_output=True, text=True, timeout=30)

    def test_the_build_is_signed_ad_hoc(self):
        result = self.build("CodeDirectory v=20500 flags=0x10002(adhoc,runtime)\nSignature=adhoc")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "flutter-sign-identity").read_text(), "-")

    def test_a_build_with_a_real_signature_is_refused(self):
        result = self.build("CodeDirectory v=20500 flags=0x10000(runtime)\n"
                            "Authority=Developer ID Application: Fixture (TEAM)")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ad hoc", result.stderr)


if __name__ == "__main__":
    unittest.main()
