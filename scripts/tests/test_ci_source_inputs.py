import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("ci_inputs", Path(__file__).resolve().parents[1] / "ci-source-inputs.py")
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


class SourceInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name in (".github/workflows/ci.yml", "scripts/check.py", "desktop/scripts/upload.sh",
                     "desktop/lib/main.dart", "desktop/test/app_test.dart", "cli/main.ts", "docs/guide.md",
                     "tests/fixtures/layout.json", "daemons/frames.json", "store/catalog.json", "docs/images/poster.png"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n")
        self.git("init", "-q")
        self.git("add", ".")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "source")
        self.sha = self.git("rev-parse", "HEAD")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE, text=True).strip()

    def sparse(self, paths):
        subprocess.run(["git", "sparse-checkout", "set", "--no-cone", "--stdin"], cwd=self.root,
                       input="\n".join("/" + path for path in paths) + "\n", text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    def test_process_checkout_removes_unrelated_source_but_keeps_every_declared_input(self):
        self.sparse(inputs.ci.SOURCE_INPUTS["process"])
        inputs.verify_checkout(self.root, "process")
        self.assertTrue((self.root / "desktop/scripts/upload.sh").exists())
        self.assertFalse((self.root / "desktop/lib/main.dart").exists())
        self.assertFalse((self.root / "cli/main.ts").exists())
        self.assertFalse((self.root / "docs/guide.md").exists())

    def test_desktop_checkout_and_aggregate_subset_are_bounded_by_the_same_contract(self):
        self.sparse(inputs.ci.SOURCE_INPUTS["desktop"])
        inputs.verify_checkout(self.root, "desktop")
        self.assertTrue((self.root / "desktop/lib/main.dart").exists())
        for path in ("cli/main.ts", "tests/fixtures/layout.json", "daemons/frames.json", "store/catalog.json", "docs/images/poster.png"):
            self.assertTrue((self.root / path).exists(), path)
        self.sparse(["scripts/", "desktop/test/"])
        inputs.verify_checkout(self.root, "desktop", subset=True)
        with self.assertRaisesRegex(ValueError, "complete declared"):
            inputs.verify_checkout(self.root, "desktop")

    def test_full_wildcard_or_expanded_checkout_cannot_claim_a_narrow_scope(self):
        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
            inputs.verify_checkout(self.root, "process")
        for paths in ([*inputs.ci.SOURCE_INPUTS["process"], "cli/"], ["*"]):
            self.sparse(paths)
            with self.assertRaises(ValueError):
                inputs.verify_checkout(self.root, "process")

    def test_checkout_actions_default_non_cone_mode_is_supported(self):
        self.sparse(inputs.ci.SOURCE_INPUTS["process"])
        self.git("config", "--worktree", "--unset", "core.sparseCheckoutCone")
        inputs.verify_checkout(self.root, "process")
        self.git("config", "--worktree", "core.sparseCheckoutCone", "true")
        with self.assertRaisesRegex(ValueError, "non-cone"):
            inputs.verify_checkout(self.root, "process")

    def test_populated_undeclared_file_and_dirty_source_are_rejected(self):
        self.sparse(inputs.ci.SOURCE_INPUTS["process"])
        path = self.root / "cli/main.ts"
        path.parent.mkdir(parents=True)
        path.write_text("fixture\n")
        with self.assertRaisesRegex(ValueError, "undeclared tracked"):
            inputs.verify_checkout(self.root, "process")
        path.unlink()
        (self.root / "scripts/check.py").write_text("dirty\n")
        with self.assertRaisesRegex(ValueError, "clean"):
            inputs.verify_checkout(self.root, "process")

    def test_capture_binds_git_objects_to_the_real_source_run_and_attempt(self):
        self.sparse(inputs.ci.SOURCE_INPUTS["process"])
        with mock.patch.dict(os.environ, GITHUB_SHA=self.sha, GITHUB_RUN_ID="123", GITHUB_RUN_ATTEMPT="2"):
            result = inputs.capture(self.root)
            self.assertEqual(result["source_sha"], self.sha)
            self.assertEqual(result["run_attempt"], 2)
            self.assertEqual(set(result["scopes"]), {"process", "desktop"})
            self.assertEqual(result["scopes"]["desktop"], inputs.ci.input_snapshot(self.root, self.sha, "desktop"))
            with mock.patch.dict(os.environ, GITHUB_SHA="b" * 40):
                with self.assertRaisesRegex(ValueError, "differs from the CI source"):
                    inputs.capture(self.root)


if __name__ == "__main__":
    unittest.main()
