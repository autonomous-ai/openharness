import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location(
    "website_release", Path(__file__).resolve().parents[2]
    / "desktop/scripts/verify-website-only-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class WebsiteOnlyReleaseTests(unittest.TestCase):
    def setUp(self):
        self.manifest = dict(version="1.3.25", sourceCommit="a" * 40,
                             sha256="b" * 64, baseHref="/harness-web/",
                             apiUrl="https://harness-api.autonomous.ai",
                             archiveUrl="https://github.com/autonomous-ai/openharness/"
                             "releases/download/v1.3.25_web/harness-web-1.3.25.tar.gz")
        self.published = {key: self.manifest[key] for key in
                          ("version", "sourceCommit", "baseHref", "apiUrl")}

    def test_accepts_deployed_bundle(self):
        self.assertEqual(release.verify(self.manifest, self.published), "1.3.25")

    def test_rejects_downgrade_changed_source_and_configuration(self):
        for field, value in (("version", "1.3.26"), ("sourceCommit", "c" * 40),
                             ("baseHref", "/app/"), ("apiUrl", "https://other.example")):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "differs from production"):
                release.verify(self.manifest, {**self.published, field: value})

    def test_rejects_wrong_artifact_and_missing_hash(self):
        for field, value in (("archiveUrl", "https://other.example/archive.tar.gz"),
                             ("sha256", ""), ("sourceCommit", "main"), ("version", "latest")):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "Invalid pinned"):
                release.verify({**self.manifest, field: value}, self.published)


if __name__ == "__main__":
    unittest.main()
