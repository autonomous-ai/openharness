"""Cache trimming must preserve every desktop tool and stay inside its SDK."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("desktop_sdk_cache", ROOT / ".github/actions/desktop-flutter/trim-cache.py")
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class DesktopSdkCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "SDK with spaces"
        self.engine = self.root / "bin/cache/artifacts/engine"
        self.engine.mkdir(parents=True)
        (self.root / "bin/flutter").write_text("launcher")

    def artifact(self, name):
        path = self.engine / name
        path.mkdir()
        (path / "payload").write_text(name)
        return path

    def test_removes_only_mobile_engine_artifacts_and_is_repeatable(self):
        mobile = ["android-arm", "android-arm64-release", "android-x86", "ios", "ios-profile", "ios-release"]
        kept = ["darwin-x64", "darwin-x64-release", "darwin-x64-profile", "linux-arm64", "linux-x64-release", "common", "future-engine"]
        for name in mobile + kept:
            self.artifact(name)
        other = self.root / "packages/android-arm"
        other.mkdir(parents=True)
        (other / "source.dart").write_text("keep SDK source")
        self.assertEqual(cache.trim_cache(self.root), sorted(mobile))
        self.assertTrue(all(not (self.engine / name).exists() for name in mobile))
        for name in kept:
            self.assertEqual((self.engine / name / "payload").read_text(), name)
        self.assertEqual((other / "source.dart").read_text(), "keep SDK source")
        self.assertEqual((self.root / "bin/flutter").read_text(), "launcher")
        self.assertEqual(cache.trim_cache(self.root), [])

    def test_rejects_a_directory_that_is_not_an_sdk(self):
        mobile = self.artifact("ios")
        (self.root / "bin/flutter").unlink()
        with self.assertRaises(ValueError):
            cache.trim_cache(self.root)
        self.assertTrue(mobile.exists())

    def test_rejects_an_engine_cache_redirected_outside_the_sdk(self):
        outside = Path(self.temp.name) / "outside"
        self.engine.rename(outside)
        self.engine.symlink_to(outside, target_is_directory=True)
        (outside / "ios").mkdir()
        with self.assertRaises(ValueError):
            cache.trim_cache(self.root)
        self.assertTrue((outside / "ios").exists())

    def test_checks_all_top_level_artifacts_before_removing_any(self):
        mobile = self.artifact("android-arm")
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (outside / "payload").write_text("keep outside data")
        (self.engine / "ios").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ValueError):
            cache.trim_cache(self.root)
        self.assertTrue(mobile.exists())
        self.assertEqual((outside / "payload").read_text(), "keep outside data")

    def test_internal_framework_links_do_not_remove_their_targets(self):
        mobile = self.artifact("ios")
        outside = Path(self.temp.name) / "outside"
        outside.write_text("keep outside data")
        (mobile / "linked-framework").symlink_to(outside)
        self.assertEqual(cache.trim_cache(self.root), ["ios"])
        self.assertEqual(outside.read_text(), "keep outside data")


if __name__ == "__main__":
    unittest.main()
