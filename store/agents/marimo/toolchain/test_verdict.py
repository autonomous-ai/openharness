import contextlib, io, json, os, runpy, subprocess, sys, tempfile, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import count_cells, judge

HERE = Path(__file__).resolve().parent

NB = '''import marimo
app = marimo.App()

@app.cell
def _():
    import marimo as mo
    return (mo,)

@app.cell
def _(mo):
    mo.md("hi")
    return
'''

# What `marimo check` (the pinned 0.24.2) prints for a notebook with one breaking and one formatting
# issue: a header per issue, where it is, an excerpt, a hint, a count.
CHECK_OUT = """critical[multiple-definitions]: Variable 'x' is defined in multiple cells
 --> /Users/example/ws/notebook.py:7:1
   7 | def _():
   8 |     x = 1
     |     ^
   ...
  13 | def _():
hint: Variables must be unique across cells. Alternatively, they can be private with an underscore prefix (i.e. `_x`.)

warning[general-formatting]: Expected `__generated_with` assignment for marimo version number.
 --> /Users/example/ws/notebook.py:2:1
   2 |
     |     ^

Found 2 issues.
"""


class Verdict(unittest.TestCase):
    def test_cells_are_counted(self):
        self.assertEqual(count_cells(NB), 2); self.assertEqual(count_cells("def ("), -1)
    def test_async_cells_functions_and_classes_are_cells(self):
        source = NB + "\n@app.cell\nasync def _():\n    return\n\n@app.function\ndef helper():\n    return 1\n\n@app.class_definition\nclass Thing:\n    pass\n\n@staticmethod\ndef not_a_cell():\n    pass\n"
        self.assertEqual(count_cells(source), 5)
    def test_runs(self):
        v = judge(2, "All checks passed", 0, "", 0, "notebook.py")
        self.assertTrue(v["ready"]); self.assertEqual(v["summary"], "notebook.py · 2 cells · runs")
        self.assertEqual(v["findings"], [])
    def test_check_failure(self):
        v = judge(2, "notebook.py:12: error MB001 multiple definitions of x", 1, None, None, "notebook.py")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed"); self.assertEqual(v["findings"][0]["severity"], "error")
    def test_run_failure(self):
        v = judge(2, "", 0, "Traceback\nZeroDivisionError: division by zero", 1, "notebook.py")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][2]["state"], "failed"); self.assertIn("ZeroDivisionError", v["findings"][0]["message"])
    def test_a_run_that_failed_silently_says_how_it_exited(self):
        v = judge(1, "", 0, None, -9, "notebook.py")
        self.assertEqual(v["findings"][0]["message"], "the notebook exited -9")
        self.assertEqual(v["summary"], "notebook.py · 1 cell · 1 error")

    def test_one_finding_per_issue_with_its_place_not_one_per_line(self):
        v = judge(3, CHECK_OUT, 1, None, None, "notebook.py")
        self.assertEqual(v["findings"], [
            {"severity": "error", "kind": "check", "message": "Variable 'x' is defined in multiple cells (multiple-definitions)", "ref": "notebook.py:7:1"},
            {"severity": "warning", "kind": "check", "message": "Expected `__generated_with` assignment for marimo version number. (general-formatting)", "ref": "notebook.py:2:1"},
        ])
        self.assertEqual(v["summary"], "notebook.py · 3 cells · 1 error")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "failed", "pending"])

    def test_formatting_warnings_do_not_stop_a_notebook_that_runs(self):
        out = "warning[markdown-indentation]: Markdown cell should be dedented\n --> notebook.py:16:1\n  16 | @app.cell\n\nFound 1 issue.\n"
        v = judge(5, out, 0, "", 0, "notebook.py")
        self.assertTrue(v["ready"])
        self.assertEqual([(f["severity"], f.get("ref")) for f in v["findings"]], [("warning", "notebook.py:16:1")])

    def test_a_runtime_error_fails_the_check_even_when_check_exits_0(self):
        v = judge(2, "error[self-import]: Importing a module with the same name as the file\n", 0, "", 0, "notebook.py")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertNotIn("ref", v["findings"][0], "a header with nothing after it has no place")

    def test_info_stays_info(self):
        v = judge(2, "info[wasm]: not available in WebAssembly\n --> notebook.py:3:1\n", 0, "", 0, "notebook.py")
        self.assertTrue(v["ready"]); self.assertEqual(v["findings"][0]["severity"], "info")

    def test_a_check_that_fails_without_an_issue_says_why(self):
        v = judge(2, "Failed to parse: notebook.py (not a valid notebook)\n", 1, None, None, "notebook.py")
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "check", "message": "Failed to parse: notebook.py (not a valid notebook)"}])
        v = judge(2, "", 2, None, None, "notebook.py")
        self.assertEqual(v["findings"][0]["message"], "marimo check exited 2")

    def test_a_notebook_that_does_not_parse(self):
        v = judge(-1, "", None, None, None, "notebook.py")
        self.assertFalse(v["ready"]); self.assertIsNone(v["artifact"])
        self.assertEqual(v["summary"], "notebook.py · 1 error")
        self.assertEqual(v["findings"][0]["kind"], "syntax")

    def test_nothing_written_yet(self):
        v = judge(0, "", None, None, None, "notebook.py")
        self.assertEqual(v["summary"], "notebook.py · no cells yet")
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])

    def test_checked_but_not_run(self):
        self.assertEqual(judge(2, "", 0, None, None, "notebook.py")["summary"], "notebook.py · 2 cells · not run")


def completed(args, code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, code, stdout, stderr)


class Main(unittest.TestCase):
    """verdict.py on a workspace, with `marimo check` and the notebook run stubbed at subprocess.run."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name)
        for name, value in (("WS", self.ws), ("MARIMO", "/Users/example/.venv/bin/marimo"), ("PY", "/Users/example/.venv/bin/python")):
            patcher = mock.patch.object(verdict, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def main(self, *argv, run=None):
        calls = []

        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            return run(args) if run else completed(args)

        out = io.StringIO()
        with mock.patch.object(verdict.subprocess, "run", fake_run), contextlib.redirect_stdout(out):
            code = verdict.main(["verdict.py", *argv])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text()), calls

    def test_a_notebook_that_checks_and_runs(self):
        (self.ws / "notebook.py").write_text(NB)
        code, printed, v, calls = self.main()
        self.assertEqual(code, 0)
        self.assertEqual(printed.splitlines(), ["ready · notebook.py · 2 cells · runs"])
        target = str(self.ws / "notebook.py")
        self.assertEqual([c[0] for c in calls], [["/Users/example/.venv/bin/marimo", "check", target], ["/Users/example/.venv/bin/python", target]])
        self.assertEqual({(c[1]["cwd"], c[1]["timeout"]) for c in calls}, {(self.ws, 120), (self.ws, 300)})

    def test_a_named_notebook_and_a_failing_check_that_skips_the_run(self):
        (self.ws / "analysis.py").write_text(NB)
        code, printed, v, calls = self.main(str(self.ws / "analysis.py"), run=lambda args: completed(args, 1, CHECK_OUT))
        self.assertEqual(code, 1)
        self.assertEqual(len(calls), 1, "a notebook that fails its check is not run")
        self.assertEqual(v["artifact"], "analysis.py")
        self.assertEqual(printed.splitlines(), ["not ready · analysis.py · 2 cells · 1 error",
                                                "  error   Variable 'x' is defined in multiple cells (multiple-definitions)",
                                                "  warning Expected `__generated_with` assignment for marimo version number. (general-formatting)"])

    def test_check_output_on_stderr_counts_too(self):
        (self.ws / "notebook.py").write_text(NB)
        _, _, v, _ = self.main(run=lambda args: completed(args, 1, "", "Failed to parse: notebook.py (not a valid notebook)\n"))
        self.assertEqual(v["findings"][0]["message"], "Failed to parse: notebook.py (not a valid notebook)")

    def test_marimo_missing(self):
        (self.ws / "notebook.py").write_text(NB)

        def run(args):
            raise FileNotFoundError(2, "No such file or directory", args[0])

        _, _, v, calls = self.main(run=run)
        self.assertEqual(len(calls), 1)
        self.assertTrue(v["findings"][0]["message"].startswith("error: marimo check could not run ("), v["findings"])
        self.assertEqual(v["phases"][1]["state"], "failed")

    def test_a_check_that_hangs(self):
        (self.ws / "notebook.py").write_text(NB)

        def run(args):
            raise subprocess.TimeoutExpired(args, 120)

        _, _, v, _ = self.main(run=run)
        self.assertIn("could not run", v["findings"][0]["message"])

    def test_a_notebook_that_hangs(self):
        (self.ws / "notebook.py").write_text(NB)

        def run(args):
            if args[1] == "check":
                return completed(args)
            raise subprocess.TimeoutExpired(args, 300)

        code, _, v, _ = self.main(run=run)
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "run", "message": "the notebook did not finish within 5 minutes"}])
        self.assertEqual(v["phases"][2]["state"], "failed")

    def test_no_notebook_and_a_broken_notebook_run_nothing(self):
        code, _, v, calls = self.main()
        self.assertEqual((code, calls, v["summary"]), (1, [], "notebook.py · no cells yet"))
        (self.ws / "notebook.py").write_text("def (")
        code, _, v, calls = self.main()
        self.assertEqual((code, calls, v["summary"]), (1, [], "notebook.py · 1 error"))

    def test_run_as_a_script(self):
        (self.ws / "notebook.py").write_text(NB)
        env = {"HARNESS_WORKSPACE": str(self.ws), "MARIMO": "/Users/example/.venv/bin/marimo"}
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["verdict.py"]), \
                mock.patch("subprocess.run", lambda args, **kw: completed(args)), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
        self.assertEqual(exit_.exception.code, 0)
        self.assertTrue(json.loads((self.ws / ".harness" / "verdict.json").read_text())["ready"])


try:
    import marimo  # noqa: F401
except ImportError:  # the plain `python3 -m unittest` run, outside the venv
    marimo = None

GOOD = '''import marimo

__generated_with = "0.24.2"
app = marimo.App()


@app.cell
def _():
    x = 1
    return (x,)


@app.cell
async def _(x):
    y = x + 1
    return (y,)


@app.class_definition
class Thing:
    value = 3


if __name__ == "__main__":
    app.run()
'''


@unittest.skipIf(marimo is None, "marimo is not importable here; run with .venv/bin/python")
class RealMarimo(unittest.TestCase):
    """The pinned marimo's own check and the notebook run as a script, on notebooks small enough to read."""

    def verdict_for(self, source: str) -> tuple[int, dict]:
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "notebook.py").write_text(source)
            with mock.patch.object(verdict, "WS", Path(d)), mock.patch.object(verdict, "PY", sys.executable), \
                    mock.patch.object(verdict, "MARIMO", str(Path(sys.executable).parent / "marimo")), contextlib.redirect_stdout(io.StringIO()):
                code = verdict.main(["verdict.py"])
            return code, json.loads((Path(d) / ".harness" / "verdict.json").read_text())

    def test_a_clean_notebook_with_async_cells_and_a_class_is_ready(self):
        code, v = self.verdict_for(GOOD)
        self.assertEqual(code, 0, v)
        self.assertEqual(v["summary"], "notebook.py · 3 cells · runs")
        self.assertEqual(v["findings"], [])

    def test_a_breaking_issue_is_one_error_with_its_place(self):
        code, v = self.verdict_for(GOOD.replace("    y = x + 1\n    return (y,)", "    x = 2\n    return (x,)").replace("async def _(x)", "def _()"))
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "check", "message": "Variable 'x' is defined in multiple cells (multiple-definitions)", "ref": "notebook.py:8:1"}])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "failed", "pending"])

    def test_a_cell_that_raises_fails_the_run(self):
        code, v = self.verdict_for(GOOD.replace("x = 1", "x = 1 / 0"))
        self.assertEqual(code, 1)
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "run", "message": "ZeroDivisionError: division by zero"}])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "failed"])


if __name__ == "__main__": unittest.main()
