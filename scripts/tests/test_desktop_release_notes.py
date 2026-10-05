"""Exercise normal shallow tag notes and the legacy full-history fallback."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DesktopReleaseNotesTests(unittest.TestCase):
    def test_annotated_tag_keeps_checkout_shallow(self):
        self.exercise(annotated=True)

    def test_lightweight_tag_fetches_history_for_fallback(self):
        self.exercise(annotated=False)

    def exercise(self, annotated):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            remote = root / "source"
            remote.mkdir()

            def git(*args, cwd=remote):
                return subprocess.check_output(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", *args], cwd=cwd, stderr=subprocess.STDOUT, text=True).strip()

            git("init", "-q")
            git("commit", "--allow-empty", "-qm", "previous release")
            git("tag", "-a", "v1.2.1_desktop", "-m", "previous notes")
            git("commit", "--allow-empty", "-qm", "A useful fix")
            tag = "v1.2.2_desktop"
            if annotated:
                git("tag", "-a", tag, "-m", "Reviewed release notes")
            else:
                git("tag", tag)
            checkout = root / "checkout"
            git("clone", "--quiet", "--depth=1", "--branch", tag, remote.as_uri(), str(checkout))
            # Match actions/checkout's local lightweight ref even for an annotated
            # remote tag. The workflow must restore the real tag object.
            git("tag", "-f", tag, "HEAD", cwd=checkout)
            workflow = (ROOT / ".github/workflows/release-desktop.yml").read_text()
            block = workflow.split("      - name: Take the release notes from the tag\n", 1)[1]
            script = textwrap.dedent(re.split(r"\n      - (?:name|uses):", block.split("        run: |\n", 1)[1], maxsplit=1)[0])
            env = dict(os.environ, REF_NAME=tag, VERSION="1.2.2")
            result = subprocess.run(["bash", "-e", "-c", script], cwd=checkout, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn("here-document", result.stderr)
            notes = (checkout / "RELEASE_NOTES.md").read_text()
            self.assertIn("## Downloads", notes)
            self.assertNotIn('echo "::group::', notes)
            self.assertEqual(git("rev-parse", "--is-shallow-repository", cwd=checkout), "true" if annotated else "false")
            if annotated:
                self.assertTrue(notes.startswith("Reviewed release notes"))
            else:
                self.assertIn("- A useful fix", notes)
                self.assertNotIn("- previous release", notes)


if __name__ == "__main__":
    unittest.main()
