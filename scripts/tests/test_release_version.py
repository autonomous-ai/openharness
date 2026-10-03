import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("release_version", Path(__file__).resolve().parents[1] / "check-release-version.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseVersionTests(unittest.TestCase):
    def test_accepts_new_patch_minor_and_major_versions_numerically(self):
        for requested, current in [("0.1.10", "0.1.9"), ("0.2.0", "0.1.99"), ("1.0.0", "0.99.99")]:
            release.require_new_version(requested, {"version": current})

    def test_rejects_same_version_republication(self):
        with self.assertRaisesRegex(ValueError, "not newer"):
            release.require_new_version("0.1.10", {"version": "0.1.10"})

    def test_rejects_an_older_build_that_finishes_after_a_newer_one(self):
        with self.assertRaisesRegex(ValueError, "not newer"):
            release.require_new_version("0.1.10", {"version": "0.1.11"})

    def test_corrupt_manifest_does_not_become_an_empty_baseline(self):
        for manifest in [None, [], {}, {"version": "garbage"}]:
            with self.assertRaises(ValueError):
                release.require_new_version("0.1.11", manifest)

    def test_rejects_ambiguous_or_nonrelease_versions(self):
        for version in ["01.2.3", "1.2", "v1.2.3", "1.2.3-dev", "1.2.3\n", 123]:
            with self.assertRaises(ValueError):
                release.require_new_version(version, {"version": "0.1.10"})


if __name__ == "__main__":
    unittest.main()
