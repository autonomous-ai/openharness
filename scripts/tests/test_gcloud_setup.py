"""A missing or unhealthy runner SDK must retain the normal installation path."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "gcloud_setup", ROOT / ".github/actions/setup-gcloud/check-installed.py",
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class GcloudSetupTests(unittest.TestCase):
    def probe(self, value):
        with patch.object(setup.subprocess, "run", return_value=SimpleNamespace(stdout=json.dumps(value))):
            return setup.installed_version()

    def test_validated_floor_and_newer_versions_are_reused(self):
        for version in ("586.0.0", "586.1.2", "600.0.0"):
            with self.subTest(version=version):
                self.assertEqual(self.probe({"Google Cloud SDK": version}), version)

    def test_older_and_unrecognized_versions_require_installation(self):
        for version in ("585.99.99", "85.0.0", None, 586, "latest", "586.0.0-beta", "586.0.0\nreusable=true"):
            with self.subTest(version=version):
                self.assertIsNone(self.probe({"Google Cloud SDK": version}))
        for value in ({}, [], None, "586.0.0"):
            with self.subTest(value=value):
                self.assertIsNone(self.probe(value))

    def test_malformed_json_requires_installation(self):
        with patch.object(setup.subprocess, "run", return_value=SimpleNamespace(stdout="not JSON")):
            self.assertIsNone(setup.installed_version())

    def test_missing_broken_and_slow_installations_fall_back(self):
        for error in (
            FileNotFoundError(), PermissionError(),
            subprocess.CalledProcessError(1, ["gcloud"], stderr="private diagnostic"),
            subprocess.TimeoutExpired(["gcloud"], 10, stderr="private diagnostic"),
            UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid encoding"),
        ):
            with self.subTest(error=type(error).__name__), patch.object(setup.subprocess, "run", side_effect=error):
                self.assertIsNone(setup.installed_version())

    def test_probe_is_bounded_and_captures_diagnostics(self):
        with patch.object(setup.subprocess, "run", return_value=SimpleNamespace(stdout="{}")) as run:
            setup.installed_version()
        run.assert_called_once_with(
            ["gcloud", "version", "--format=json"],
            check=True, capture_output=True, text=True, timeout=10,
        )

    def test_action_output_is_boolean_and_preserves_other_outputs(self):
        for version, expected in (("586.0.0", "true"), (None, "false")):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "output"
                output.write_text("earlier=value\n")
                with patch.dict(os.environ, GITHUB_OUTPUT=str(output)), \
                        patch.object(setup, "installed_version", return_value=version), \
                        redirect_stdout(io.StringIO()):
                    setup.main()
                self.assertEqual(output.read_text(), f"earlier=value\nreusable={expected}\n")


if __name__ == "__main__":
    unittest.main()
