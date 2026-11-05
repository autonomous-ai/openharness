"""The release scripts and tag workflows call the release-window guard before they publish anything."""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_OF = {
    "backend": "backend/scripts/release-be.sh",
    "cli": "cli/scripts/release-cli.sh",
    "desktop": "desktop/scripts/release-desktop.sh",
    "web": "desktop/scripts/release-web.sh",
}
WORKFLOW_OF = {
    "backend": ".github/workflows/production-be-build.yaml",
    "cli": ".github/workflows/release.yml",
    "desktop": ".github/workflows/release-desktop.yml",
    "web": ".github/workflows/release-web.yml",
}
# The first thing each workflow does with the tag after the guard.
AFTER_GUARD = {
    "backend": "Work out the image tag",
    "cli": "id: resolve",
    "desktop": "id: resolve",
    "web": "Work out the version and image tag",
}
STUB = """#!/usr/bin/env python3
import os, sys
with open(os.environ["STUB_LOG"], "a") as log:
    log.write(" ".join(sys.argv[1:]) + "\\n")
code = int(os.environ.get("STUB_CODE", "0"))
if code:
    print("RELEASE_WINDOW: stub refusal", file=sys.stderr)
if code == 0 and "--urgent" in sys.argv:
    print("Urgent line from the stub")
sys.exit(code)
"""


def git(cwd, *args):
    return subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}).stdout


class WorkflowTests(unittest.TestCase):
    def test_each_tag_workflow_checks_the_window_before_it_does_anything_with_the_tag(self):
        for kind, path in WORKFLOW_OF.items():
            text = (ROOT / path).read_text()
            call = re.search(rf"release-window\.py --kind {kind}\b[^\n]*", text)
            self.assertIsNotNone(call, f"{path} never calls the guard")
            self.assertIn('--from-tag "$REF_NAME"', call.group(0), path)
            self.assertIn('--exclude-tag "$REF_NAME"', call.group(0), path)
            self.assertLess(text.index("actions/checkout"), call.start(), f"{path}: no checkout before the guard")
            self.assertLess(call.start(), text.index(AFTER_GUARD[kind]), f"{path}: guard runs too late")

    def test_workflows_guard_only_tag_pushes(self):
        for kind, path in WORKFLOW_OF.items():
            text = (ROOT / path).read_text()
            end = text.index(f"release-window.py --kind {kind}")
            step = text[max(0, end - 700):end]
            self.assertRegex(step, r"github\.event_name == 'push'|github\.ref_type == 'tag'", path)

    def test_release_notes_do_not_publish_the_urgent_line(self):
        for path in [WORKFLOW_OF["cli"], WORKFLOW_OF["desktop"]]:
            text = (ROOT / path).read_text()
            self.assertIn("Release-Urgent", text, path)

    def test_web_guard_runs_for_a_new_tag_before_it_is_made(self):
        text = (ROOT / SCRIPT_OF["web"]).read_text()
        guard = text.index("release_window_guard web")
        self.assertLess(text.index("TAG_EXISTS=0"), guard)
        self.assertLess(guard, text.index('git tag -a "$TAG"'))
        self.assertIn('Release-Urgent', text + (ROOT / "scripts/release-window.sh").read_text())


class ScriptTests(unittest.TestCase):
    """Each script is run in a scratch copy of the repository with the guard replaced by a stub."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        self.origin = Path(self.tmp.name) / "origin.git"
        subprocess.run(["git", "init", "-q", "--bare", str(self.origin)], check=True)
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        (self.repo / "scripts").mkdir()
        (self.repo / "scripts/release-window.py").write_text(STUB)
        shutil.copy(ROOT / "scripts/release-window.sh", self.repo / "scripts/release-window.sh")
        for rel in SCRIPT_OF.values():
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(ROOT / rel, target)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "init")
        git(self.repo, "remote", "add", "origin", str(self.origin))
        git(self.repo, "push", "-q", "origin", "main")
        git(self.repo, "fetch", "-q", "origin")
        self.log = Path(self.tmp.name) / "guard.log"

    def run_script(self, kind, *args, code=0):
        env = {**os.environ, "STUB_LOG": str(self.log), "STUB_CODE": str(code), "BRANCH": "main"}
        return subprocess.run(["bash", str(self.repo / SCRIPT_OF[kind]), *args], capture_output=True, text=True,
                              env=env, cwd=self.repo, timeout=60)

    def guard_calls(self):
        return self.log.read_text().splitlines() if self.log.exists() else []

    def test_every_script_stops_with_the_guards_exit_code_before_publishing(self):
        for kind in ["backend", "cli", "desktop"]:
            with self.subTest(kind=kind):
                result = self.run_script(kind, code=2)
                self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                self.assertIn("RELEASE_WINDOW", result.stderr)
                self.assertTrue(self.guard_calls()[-1].startswith(f"--kind {kind}"), self.guard_calls())
                self.assertEqual(git(self.origin, "tag", "-l").strip(), "")
                self.log.unlink()

    def test_urgent_reason_reaches_the_guard(self):
        for kind in ["backend", "cli", "desktop"]:
            with self.subTest(kind=kind):
                self.run_script(kind, "--urgent", "P0: sign-out loop", code=2)
                self.assertIn("--urgent P0: sign-out loop", self.guard_calls()[-1])
                self.log.unlink()

    def test_urgent_without_a_reason_still_reaches_the_guard_to_be_refused(self):
        for kind in ["backend", "cli", "desktop"]:
            with self.subTest(kind=kind):
                self.run_script(kind, "--urgent", code=2)
                self.assertIn("--urgent", self.guard_calls()[-1])
                self.log.unlink()

    def test_dry_run_asks_the_guard_for_advice_only(self):
        for kind in ["backend", "cli", "desktop"]:
            with self.subTest(kind=kind):
                self.run_script(kind, "--dry-run", code=0)
                self.assertIn("--advisory", self.guard_calls()[0])
                self.log.unlink()

    def test_desktop_candidate_for_prepare_is_not_a_release(self):
        self.run_script("desktop", "--prepare", code=2)
        self.assertEqual(self.guard_calls(), [])

    def test_backend_urgent_release_is_tagged_with_its_reason(self):
        result = self.run_script("backend", "--urgent", "P0: sign-out\nloop", code=0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        tag = git(self.origin, "tag", "-l", "v*_backend").split()[0]
        body = git(self.origin, "tag", "-l", "--format=%(contents)", tag)
        self.assertIn("Release-Urgent: P0: sign-out loop", body)

    def test_backend_normal_release_has_no_urgent_line(self):
        result = self.run_script("backend", code=0)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        tag = git(self.origin, "tag", "-l", "v*_backend").split()[0]
        self.assertNotIn("Release-Urgent", git(self.origin, "tag", "-l", "--format=%(contents)", tag))


if __name__ == "__main__":
    unittest.main()
