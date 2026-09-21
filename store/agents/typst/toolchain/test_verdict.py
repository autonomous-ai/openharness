import contextlib, io, json, os, runpy, sys, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import tempfile
import verdict
from verdict import judge, page_count

HERE = Path(__file__).resolve().parent


class Judge(unittest.TestCase):
    def test_compiles_clean(self):
        v = judge("= Hi", "", 0, "out/main.pdf", 2)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "main.pdf · 2 pages · compiles")
    def test_error_is_parsed_with_its_place(self):
        diag = "error: unknown variable: foo\n  ┌─ main.typ:3:5\n  │\n3 │ #foo\n"
        v = judge("#foo", diag, 1, None, None)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0], {"severity": "error", "kind": "typst", "message": "unknown variable: foo", "ref": "main.typ:3:5"})
        self.assertEqual(v["summary"], "1 error")
    def test_warning_keeps_review_open(self):
        diag = "warning: unused import\n  ┌─ main.typ:1:1\n"
        v = judge("x", diag, 0, "out/main.pdf", 1)
        self.assertTrue(v["ready"]); self.assertEqual(v["phases"][2]["state"], "active")
        self.assertEqual(v["summary"], "main.pdf · 1 page · compiles")
    def test_errors_are_counted_and_a_diagnostic_without_a_place_has_no_ref(self):
        v = judge("x", "error: one\nerror: two\n", 1, "out/main.pdf", 3)
        self.assertEqual(v["summary"], "main.pdf · 3 pages · 2 errors")
        self.assertNotIn("ref", v["findings"][0])
    def test_a_failed_compile_without_diagnostics(self):
        v = judge("x", "", 101, None, None)
        self.assertFalse(v["ready"]); self.assertEqual(v["summary"], "not compiled")
    def test_an_empty_source_is_not_a_document_even_if_it_compiles(self):
        v = judge("  \n", "", 0, "out/main.pdf", 1)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])


class PageCount(unittest.TestCase):
    def test_page_labels_are_not_pages(self):
        body = b"%PDF-1.7\n1 0 obj <</Type /Pages /Count 2>>\n2 0 obj <</Type/Page>>\n3 0 obj <</Type /Page /Parent 1 0 R>>\n4 0 obj <</Type/PageLabel>>\n%%EOF"
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            f.write(body); f.flush()
            self.assertEqual(page_count(Path(f.name)), 2)
    def test_no_pages_or_no_file_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.pdf").write_bytes(b"%PDF-1.7\n%%EOF")
            self.assertIsNone(page_count(Path(d) / "a.pdf"))
            self.assertIsNone(page_count(Path(d) / "missing.pdf"))


# A stand-in for `typst compile --root WS src out`: a source containing "#foo" fails the way Typst
# does; anything else writes a two-page PDF, and "#warn" adds a warning.
FAKE_TYPST = r"""#!/bin/sh
src="$4"; out="$5"
if grep -q '#foo' "$src"; then printf 'error: unknown variable: foo\n  \342\224\214\342\224\200 main.typ:1:1\n' >&2; exit 1; fi
grep -q '#warn' "$src" && printf 'warning: unknown font family: x\n  \342\224\214\342\224\200 main.typ:2:3\n' >&2
printf '%%PDF-1.7\n<</Type /Page>>\n<</Type /Page>>\n' > "$out"
"""


class Main(unittest.TestCase):
    """verdict.py on a workspace: what it compiles, what it writes, what it prints and returns."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ws = Path(tmp.name) / "ws"
        self.ws.mkdir()
        self.typst = Path(tmp.name) / "typst"
        self.typst.write_text(FAKE_TYPST)
        self.typst.chmod(0o755)
        for name, value in (("WS", self.ws), ("TYPST", str(self.typst))):
            patcher = mock.patch.object(verdict, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = verdict.main(["verdict.py", *argv])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_a_document_that_compiles(self):
        (self.ws / "main.typ").write_text("= Hello\n#warn\n")
        code, printed, v = self.main()
        self.assertEqual(code, 0)
        self.assertEqual(v["artifact"], "out/main.pdf")
        self.assertEqual(v["summary"], "main.pdf · 2 pages · compiles")
        self.assertEqual(printed.splitlines(), ["ready · main.pdf · 2 pages · compiles", "  warning unknown font family: x  (main.typ:2:3)"])

    def test_a_named_source_relative_or_absolute(self):
        (self.ws / "paper.typ").write_text("= Paper\n")
        self.assertEqual(self.main("paper.typ")[2]["artifact"], "out/paper.pdf")
        self.assertEqual(self.main(str(self.ws / "paper.typ"))[2]["artifact"], "out/paper.pdf")

    def test_an_error_keeps_the_last_good_pdf_as_the_artifact(self):
        (self.ws / "main.typ").write_text("= Hello\n")
        self.main()
        (self.ws / "main.typ").write_text("#foo\n")
        code, printed, v = self.main()
        self.assertEqual(code, 1)
        self.assertFalse(v["ready"])
        self.assertEqual(v["artifact"], "out/main.pdf")
        self.assertEqual(v["summary"], "main.pdf · 2 pages · 1 error")
        self.assertIn("  error   unknown variable: foo  (main.typ:1:1)", printed)

    def test_no_source_names_the_missing_file(self):
        code, printed, v = self.main("paper.typ")
        self.assertEqual(code, 1)
        self.assertIsNone(v["artifact"])
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "typst", "message": "no paper.typ in the workspace"}])

    def test_no_typst_binary_is_a_finding_not_a_traceback(self):
        (self.ws / "main.typ").write_text("= Hello\n")
        with mock.patch.object(verdict, "TYPST", str(self.ws / "bin" / "typst")):
            code, _, v = self.main()
        self.assertEqual(code, 1)
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertTrue(v["findings"][0]["message"].startswith("typst could not run"), v["findings"])

    def test_run_as_a_script(self):
        (self.ws / "main.typ").write_text("= Hello\n")
        env = {"HARNESS_WORKSPACE": str(self.ws), "TYPST": str(self.typst)}
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
        self.assertEqual(exit_.exception.code, 0)
        self.assertTrue((self.ws / "out" / "main.pdf").exists())


def real_typst() -> str | None:
    """$TYPST as the harness sets it, else the install's own bin/typst."""
    for candidate in (os.environ.get("TYPST"), HERE.parent / "bin" / "typst"):
        if candidate and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


@unittest.skipIf(real_typst() is None, "no typst binary: set TYPST or run toolchain/setup.sh")
class RealTypst(unittest.TestCase):
    """The diagnostics regex against what the pinned Typst actually prints."""

    def test_diagnostics_from_the_real_compiler(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(verdict, "WS", Path(d)), mock.patch.object(verdict, "TYPST", real_typst()), contextlib.redirect_stdout(io.StringIO()):
            (Path(d) / "main.typ").write_text('= Hi\n#text(font: "NoSuchFontAnywhere")[x]\n')
            self.assertEqual(verdict.main(["verdict.py"]), 0)
            v = json.loads((Path(d) / ".harness" / "verdict.json").read_text())
            self.assertEqual(v["summary"], "main.pdf · 1 page · compiles")
            self.assertEqual([(f["severity"], f["ref"]) for f in v["findings"]], [("warning", "main.typ:2:12")])
            (Path(d) / "main.typ").write_text("#foo\n")
            self.assertEqual(verdict.main(["verdict.py"]), 1)
            v = json.loads((Path(d) / ".harness" / "verdict.json").read_text())
            self.assertEqual(v["findings"], [{"severity": "error", "kind": "typst", "message": "unknown variable: foo", "ref": "main.typ:1:1"}])


if __name__ == "__main__": unittest.main()
