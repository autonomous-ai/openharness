"""pane_client.py against a stand-in cadgen release (test/fake_cadgen.py): the copy it makes, the
shapes of release it refuses, the races it tolerates, and main()'s promise that the pane starts
whatever happens.

    python3 -m unittest discover -s test
"""
from __future__ import annotations

import contextlib
import importlib
import io
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
PACKAGE = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(PACKAGE))

import fake_cadgen  # noqa: E402
import pane_client  # noqa: E402

CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"connect-src 'self' blob: data:\" />"


@contextlib.contextmanager
def release(index_html: str | None = fake_cadgen.INDEX_HTML):
    """`import cadgen` and its metadata answer from a fresh fake release for the duration."""
    site = fake_cadgen.make_site(index_html)
    saved = sys.modules.pop("cadgen", None)
    sys.path.insert(0, str(site))
    importlib.invalidate_caches()
    try:
        yield site / "cadgen" / "_runtime" / "viewer"
    finally:
        sys.path.remove(str(site))
        sys.modules.pop("cadgen", None)
        if saved is not None:
            sys.modules["cadgen"] = saved
        importlib.invalidate_caches()
        shutil.rmtree(site, ignore_errors=True)


class PaneClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.here = Path(tempfile.mkdtemp(prefix="cad-viewer-pkg-"))
        self.addCleanup(shutil.rmtree, self.here, True)

    def leftovers(self) -> list[str]:
        return sorted(p.name for p in self.here.iterdir() if p.name.startswith(".pane-client-tmp-"))

    def test_copies_the_bundled_client_with_one_csp_line_and_nothing_else_changed(self) -> None:
        with release() as bundled:
            dest = pane_client.pane_client(self.here)
            self.assertEqual(dest, self.here / ".pane-client-0.5.1")
            html = (dest / "index.html").read_text(encoding="utf-8")
            self.assertEqual(html.count("Content-Security-Policy"), 1)
            self.assertIn(f'<meta charset="UTF-8" />\n    {CSP}\n', html)
            self.assertEqual(html.replace(f"\n    {CSP}", ""), (bundled / "index.html").read_text(encoding="utf-8"))
            for asset in ("assets/index.js", "assets/logo.png"):
                self.assertEqual((dest / asset).read_bytes(), (bundled / asset).read_bytes(), asset)
            self.assertEqual((dest / ".harness-pane").read_text(encoding="utf-8"), "cadgen 0.5.1\n")
            self.assertEqual(self.leftovers(), [])

    def test_a_client_already_made_for_this_version_is_reused_not_remade(self) -> None:
        with release():
            dest = pane_client.pane_client(self.here)
            (dest / "index.html").write_text("kept", encoding="utf-8")
            self.assertEqual(pane_client.pane_client(self.here), dest)
            self.assertEqual((dest / "index.html").read_text(encoding="utf-8"), "kept")

    def test_a_release_without_a_bundled_client_gets_none(self) -> None:
        with release(index_html=None):
            self.assertIsNone(pane_client.pane_client(self.here))
        self.assertEqual(list(self.here.iterdir()), [])

    def test_an_index_html_of_another_shape_is_left_alone(self) -> None:
        for html in ("<html><head><meta charset='utf-8'></head></html>", fake_cadgen.INDEX_HTML.replace("<title>", f"{CSP}\n<title>")):
            with self.subTest(html=html[:40]), release(index_html=html):
                self.assertIsNone(pane_client.pane_client(self.here))
                self.assertEqual(list(self.here.iterdir()), [])

    def test_another_pane_that_finishes_first_wins_and_this_one_uses_its_copy(self) -> None:
        def other_pane_renamed_first(src: Path, dst: Path) -> None:
            shutil.copytree(src, dst)
            raise OSError(66, "Directory not empty")

        with release(), mock.patch.object(pane_client.os, "rename", side_effect=other_pane_renamed_first):
            dest = pane_client.pane_client(self.here)
        self.assertEqual(dest, self.here / ".pane-client-0.5.1")
        self.assertTrue((dest / ".harness-pane").is_file())
        self.assertEqual(self.leftovers(), [])

    def test_a_copy_that_cannot_be_put_in_place_gets_none_and_leaves_nothing_behind(self) -> None:
        with release(), mock.patch.object(pane_client.os, "rename", side_effect=PermissionError(13, "Permission denied")):
            self.assertIsNone(pane_client.pane_client(self.here))
        self.assertEqual(list(self.here.iterdir()), [])

    def test_a_copy_that_fails_part_way_gets_none_and_leaves_nothing_behind(self) -> None:
        with release(), mock.patch.object(pane_client.shutil, "copytree", side_effect=OSError(28, "No space left on device")):
            self.assertIsNone(pane_client.pane_client(self.here))
        self.assertEqual(list(self.here.iterdir()), [])

    def test_panes_starting_together_all_get_the_one_copy(self) -> None:
        site = fake_cadgen.make_site()
        self.addCleanup(shutil.rmtree, site, True)
        shutil.copy2(PACKAGE / "pane_client.py", self.here / "pane_client.py")
        env = {**os.environ, "PYTHONPATH": str(site)}
        panes = [subprocess.Popen([sys.executable, "pane_client.py"], cwd=self.here, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for _ in range(6)]
        answers = [pane.communicate(timeout=60) for pane in panes]
        dest = (self.here / ".pane-client-0.5.1").resolve()
        for (stdout, stderr), pane in zip(answers, panes):
            self.assertEqual(pane.returncode, 0, stderr)
            self.assertEqual(Path(stdout.strip()).resolve(), dest)
        self.assertEqual(sorted(p.name for p in self.here.iterdir()), [".pane-client-0.5.1", "pane_client.py"])
        self.assertEqual((dest / "index.html").read_text(encoding="utf-8").count("Content-Security-Policy"), 1)


class MainTest(unittest.TestCase):
    def run_main(self, **patch) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(pane_client, "pane_client", **patch), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = pane_client.main()
        return code, out.getvalue(), err.getvalue()

    def test_prints_the_directory_to_pass_as_dist(self) -> None:
        self.assertEqual(self.run_main(return_value=Path("/Users/example/.pane-client-0.5.1")), (0, "/Users/example/.pane-client-0.5.1\n", ""))

    def test_prints_an_empty_line_when_there_is_no_client_to_serve(self) -> None:
        self.assertEqual(self.run_main(return_value=None), (0, "\n", ""))

    def test_any_failure_is_reported_on_stderr_and_still_exits_zero(self) -> None:
        self.assertEqual(self.run_main(side_effect=RuntimeError("boom")), (0, "\n", "pane client: boom\n"))

    def test_run_as_a_script_without_cadgen_it_exits_zero_with_an_empty_line(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(sys.modules, {"cadgen": None}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(SystemExit) as exit:
                runpy.run_path(str(PACKAGE / "pane_client.py"), run_name="__main__")
        self.assertEqual(exit.exception.code, 0)
        self.assertEqual(out.getvalue(), "\n")
        self.assertRegex(err.getvalue(), r"^pane client: .*cadgen")


if __name__ == "__main__":
    unittest.main()
