"""Run the app signing script against a fixture bundle with a recording codesign."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SIGNER = ROOT / "desktop/scripts/sign-macos-app.sh"
ENTITLEMENTS = ROOT / "desktop/macos/Runner/Release.entitlements"

CODESIGN = r'''
import json, os, sys
with open(os.environ["CODESIGN_LOG"], "a") as log:
    log.write(json.dumps(sys.argv[1:]) + "\n")
if "--verify" in sys.argv and os.environ.get("CODESIGN_FAIL") == "verify":
    sys.exit(3)
'''


class MacOSSigningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.app = root / "app with spaces/Harness.app"
        contents = self.app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "MacOS/Harness").write_text("main")
        (contents / "MacOS/Harness").chmod(0o755)
        for name, binary in (("App", "App"), ("FlutterMacOS", "FlutterMacOS")):
            versions = contents / f"Frameworks/{name}.framework/Versions/A"
            versions.mkdir(parents=True)
            (versions / binary).write_text(name)
            (versions / binary).chmod(0o755)
        (contents / "Resources/plugin.bundle/Contents").mkdir(parents=True)
        (contents / "Resources/plugin.bundle/Contents/Info.plist").write_text("plist")
        tools = root / "tools"
        tools.mkdir()
        codesign = tools / "codesign"
        codesign.write_text(f"#!{sys.executable}\n{CODESIGN}")
        codesign.chmod(0o755)
        self.log = root / "codesign.jsonl"
        self.env = dict(os.environ, PATH=f"{tools}{os.pathsep}{os.environ['PATH']}", CODESIGN_LOG=str(self.log),
                        SIGN_IDENTITY="Fixture Identity")

    def sign(self, **env):
        return subprocess.run(["bash", str(SIGNER), str(self.app)], env=dict(self.env, **env),
                              capture_output=True, text=True, timeout=30)

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def test_frameworks_are_signed_before_the_app_with_runtime_and_release_entitlements(self):
        result = self.sign()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        frameworks = {str(self.app / "Contents/Frameworks/App.framework"),
                      str(self.app / "Contents/Frameworks/FlutterMacOS.framework")}
        self.assertEqual({call[-1] for call in calls[:2]}, frameworks)
        for call in calls[:2]:
            self.assertEqual(call[:-1], ["--force", "--sign", "Fixture Identity", "--timestamp"])
        self.assertEqual(calls[2], ["--force", "--sign", "Fixture Identity", "--timestamp", "--options", "runtime",
                                    "--entitlements", str(ENTITLEMENTS), str(self.app)])
        self.assertEqual(calls[3], ["--verify", "--deep", "--strict", str(self.app)])
        self.assertEqual(len(calls), 4)

    def test_unexpected_nested_code_is_refused_before_any_signing(self):
        helper = self.app / "Contents/Resources/helper"
        helper.write_text("code")
        helper.chmod(0o755)
        login_item = self.app / "Contents/Library/LoginItems/Agent.app"
        for extra in (helper, login_item):
            with self.subTest(extra=extra.name):
                if extra is login_item:
                    helper.unlink()
                    login_item.mkdir(parents=True)
                result = self.sign()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unexpected code", result.stderr)
                self.assertEqual([call for call in self.calls() if "--sign" in call], [])

    def test_a_failed_verification_fails_the_script(self):
        result = self.sign(CODESIGN_FAIL="verify")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not verify", result.stderr)


if __name__ == "__main__":
    unittest.main()
