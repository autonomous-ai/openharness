"""studio_fetch.py against real git, with no network: the pinned "upstream" is a local repository the
test's own gitconfig reaches through `url.<base>.insteadOf`, the way a machine that sends GitHub over
SSH reaches github.com:

    python3 -m unittest store/tools/test_studio_fetch.py

The developer's own gitconfig is never read (signing, hooks and rewrites there would change what runs).
"""
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import studio_fetch  # noqa: E402

PINNED_URL = "https://github.com/example/upstream.git"


def run(*args, cwd=None):
    return subprocess.check_output(list(args), cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()


class FetchSources(unittest.TestCase):
    def setUp(self):
        workspace = tempfile.TemporaryDirectory()
        self.addCleanup(workspace.cleanup)
        self.tmp = Path(workspace.name)
        upstream = self.tmp / "upstream-src"
        # Isolated first, before any git runs: a gitconfig of the test's own that rewrites the pinned
        # https URL, as `url."git@github.com:".insteadOf https://github.com/` does on a real machine.
        gitconfig = self.tmp / "gitconfig"
        gitconfig.write_text(f'[url "file://{upstream}"]\n\tinsteadOf = {PINNED_URL}\n')
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        os.environ.update({"GIT_CONFIG_GLOBAL": str(gitconfig), "GIT_CONFIG_NOSYSTEM": "1"})
        # The pinned upstream: one commit, servable by sha.
        upstream.mkdir()
        run("git", "init", "-q", cwd=upstream)
        (upstream / "src").mkdir()
        (upstream / "src" / "tool.py").write_text("print('hi')\n")
        (upstream / "README.md").write_text("outside the sparse cone\n")
        run("git", "add", ".", cwd=upstream)
        run("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "pin", cwd=upstream)
        run("git", "config", "uploadpack.allowAnySHA1InWant", "true", cwd=upstream)
        run("git", "config", "uploadpack.allowFilter", "true", cwd=upstream)
        self.commit = run("git", "rev-parse", "HEAD", cwd=upstream)
        self.package = self.tmp / "package"
        self.package.mkdir()
        (self.package / "upstream.lock.json").write_text(json.dumps([{
            "name": "Upstream", "url": PINNED_URL, "commit": self.commit,
            "directory": "upstream", "sparse": ["src"],
        }]))
        self.target = self.package / "upstream"

    # 2026-10-06: Comfy MCP and Ableton AI failed setup with "Unexpected upstream remote" on a Mac
    # whose ~/.gitconfig sends https://github.com/ over SSH — `git remote get-url` reported the
    # rewritten URL, not the pinned one the script had itself just added.
    def test_a_url_rewrite_in_gitconfig_is_not_a_foreign_remote(self):
        self.assertTrue(
            run("git", "ls-remote", "--get-url", PINNED_URL).startswith("file://"),
            "the fixture must really rewrite the pinned URL",
        )
        studio_fetch.fetch_sources(self.package)
        self.assertEqual(run("git", "-C", str(self.target), "rev-parse", "HEAD"), self.commit)
        self.assertTrue((self.target / "src" / "tool.py").exists())
        # Running again over the checkout it made is a no-op, not a refusal.
        studio_fetch.fetch_sources(self.package)

    def test_a_remote_that_really_points_elsewhere_is_still_refused(self):
        self.target.mkdir()
        run("git", "init", "-q", cwd=self.target)
        run("git", "remote", "add", "origin", "https://github.com/someone-else/upstream.git", cwd=self.target)
        with self.assertRaises(SystemExit) as refused:
            studio_fetch.fetch_sources(self.package)
        self.assertIn("Unexpected upstream remote", str(refused.exception))

    def test_a_checkout_with_no_origin_is_refused_by_name_not_by_traceback(self):
        self.target.mkdir()
        run("git", "init", "-q", cwd=self.target)
        with self.assertRaises(SystemExit) as refused:
            studio_fetch.fetch_sources(self.package)
        self.assertIn("Unexpected upstream remote", str(refused.exception))


if __name__ == "__main__":
    unittest.main()
