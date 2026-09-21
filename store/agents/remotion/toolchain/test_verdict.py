import contextlib, io, json, os, runpy, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import composition_ids, judge

HERE = Path(__file__).resolve().parent


class Judge(unittest.TestCase):
    def test_bundles_with_a_render(self):
        v = judge(True, ["Main", "Intro"], None, "out/main.mp4", False)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "2 compositions: Main, Intro · main.mp4")
    def test_bundle_error(self):
        v = judge(True, [], "src/Main.tsx(12,5): error TS2304: Cannot find name 'foo'.", None, False)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["summary"], "does not bundle")
    def test_stale_render_is_a_warning(self):
        v = judge(True, ["Main"], None, "out/main.mp4", True)
        self.assertTrue(v["ready"]); self.assertEqual(v["phases"][2]["state"], "active"); self.assertEqual(v["findings"][0]["severity"], "warning")
        self.assertEqual(v["summary"], "1 composition: Main · main.mp4 (stale)")
    def test_no_compositions_is_an_error(self):
        v = judge(True, [], None, None, False)
        self.assertFalse(v["ready"]); self.assertIn("no compositions registered", v["findings"][0]["message"])
    def test_many_compositions_are_shortened_and_a_bundled_project_without_a_render_is_rendering_next(self):
        v = judge(True, ["A", "B", "C", "D", "E"], None, None, False)
        self.assertEqual(v["summary"], "5 compositions: A, B, C, D…")
        self.assertEqual(v["phases"][2]["state"], "active")
    def test_no_project(self):
        v = judge(False, [], None, None, False)
        self.assertEqual(v["summary"], "no project yet")
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
    def test_a_render_of_a_project_that_no_longer_bundles(self):
        v = judge(True, [], "boom", "out/main.mp4", False)
        self.assertEqual((v["summary"], v["artifact"], v["phases"][2]["state"]), ("main.mp4", "out/main.mp4", "pending"))


class CompositionIds(unittest.TestCase):
    def test_quiet_prints_every_id_on_one_line(self):
        # Remotion 4.0.525's printCompositions with --quiet: compositions.map((c) => c.id).join(' ')
        self.assertEqual(composition_ids("Main Intro Outro\n"), ["Main", "Intro", "Outro"])
    def test_chatter_and_blanks_are_not_ids(self):
        self.assertEqual(composition_ids("Bundling 100%\n\nGetting composition\n(stuff)\nMain\n"), ["Main"])


# `remotion compositions src/index.ts --quiet`, played by a script: stdout, stderr and the exit code
# come from files beside it, so each test says what the CLI answers.
FAKE = """#!/bin/sh
here="$(dirname "$0")"
cat "$here/stdout" 2>/dev/null
cat "$here/stderr" >&2 2>/dev/null
exit "$(cat "$here/code" 2>/dev/null || echo 0)"
"""


class Main(unittest.TestCase):
    """verdict.py on a workspace: what it runs, what it writes, what it prints and returns."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name) / "ws"
        self.ws.mkdir()
        self.cli = Path(tmp.name) / "cli"
        self.cli.mkdir()
        (self.cli / "remotion").write_text(FAKE)
        (self.cli / "remotion").chmod(0o755)
        for name, value in (("WS", self.ws), ("REMOTION", str(self.cli / "remotion"))):
            patcher = mock.patch.object(verdict, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def answer(self, stdout="", stderr="", code=0):
        (self.cli / "stdout").write_text(stdout); (self.cli / "stderr").write_text(stderr); (self.cli / "code").write_text(str(code))

    def project(self):
        (self.ws / "src").mkdir(exist_ok=True)
        (self.ws / "src" / "Root.tsx").write_text("export const Root = () => null\n")
        (self.ws / "src" / "index.ts").write_text("registerRoot(Root)\n")

    def write(self, rel, body=b"x", mtime=None):
        path = self.ws / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def main(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verdict.main(["verdict.py"])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_an_empty_folder_is_no_project(self):
        code, printed, v = self.main()
        self.assertEqual((code, v["summary"], v["artifact"]), (1, "no project yet", None))
        self.assertEqual(printed, "not ready · no project yet\n")

    def test_every_composition_the_quiet_cli_lists_is_counted(self):
        self.project()
        self.answer(stdout="Main Intro Outro\n")
        code, printed, v = self.main()
        self.assertEqual(code, 0)
        self.assertEqual(v["summary"], "3 compositions: Main, Intro, Outro")
        self.assertEqual(printed, "ready · 3 compositions: Main, Intro, Outro\n")

    def test_the_newest_render_is_the_artifact_and_stale_when_the_source_moved_on(self):
        self.project()
        self.answer(stdout="Main\n")
        os.utime(self.ws / "src" / "Root.tsx", (2000, 2000)); os.utime(self.ws / "src" / "index.ts", (2000, 2000))
        self.write("out/old.mp4", mtime=1000)
        self.write("out/main.webm", mtime=3000)
        self.write("out/notes.txt", mtime=9000)                      # not a render
        (self.ws / "out" / "folder.gif").mkdir()                     # not a file
        self.write("out/node_modules/cache.mp4", mtime=9000)         # never a render
        _, _, v = self.main()
        self.assertEqual((v["artifact"], v["summary"]), ("out/main.webm", "1 composition: Main · main.webm"))
        self.write("src/Main.tsx", mtime=4000)
        code, printed, v = self.main()
        self.assertEqual((code, v["summary"]), (0, "1 composition: Main · main.webm (stale)"))
        self.assertIn("  warning main.webm is older than the source — render again", printed)

    def test_a_bundle_error_is_the_last_line_the_cli_printed(self):
        self.project()
        # stderr without a final newline, and chatter on stdout: the two used to be glued into one line
        self.answer(stdout="Bundling 40%\n", stderr="Error: bundling failed\nsrc/Main.tsx(3,1): error TS1005: ';' expected.", code=1)
        code, printed, v = self.main()
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "bundle", "message": "src/Main.tsx(3,1): error TS1005: ';' expected."}])
        self.assertIn("  error   src/Main.tsx(3,1): error TS1005", printed)

    def test_a_failure_on_stdout_alone_or_silent(self):
        self.project()
        self.answer(stdout="Could not find src/index.ts\n", code=1)
        self.assertEqual(self.main()[2]["findings"][0]["message"], "Could not find src/index.ts")
        self.answer(code=3)
        _, _, v = self.main()
        self.assertEqual(v["findings"][0]["message"], "remotion compositions exited 3")

    def test_a_cli_that_cannot_run_or_hangs_is_a_bundle_error(self):
        self.project()
        with mock.patch.object(verdict, "REMOTION", str(self.ws / "missing" / "remotion")):
            _, _, v = self.main()
        self.assertTrue(v["findings"][0]["message"].startswith("remotion could not run ("), v["findings"])
        with mock.patch.object(verdict.subprocess, "run", side_effect=subprocess.TimeoutExpired(["remotion"], 600)):
            _, _, v = self.main()
        self.assertIn("timed out after 600 seconds", v["findings"][0]["message"])

    def test_run_as_a_script(self):
        self.project()
        self.answer(stdout="Main\n")
        env = {"HARNESS_WORKSPACE": str(self.ws), "REMOTION": str(self.cli / "remotion")}
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
        self.assertEqual(exit_.exception.code, 0)
        self.assertTrue(json.loads((self.ws / ".harness" / "verdict.json").read_text())["ready"])


if __name__ == "__main__": unittest.main()
