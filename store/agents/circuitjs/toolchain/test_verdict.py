#!/usr/bin/env python3
"""The judge's own tests: python3 -m unittest toolchain/test_verdict.py

The ground truth is upstream's own example circuits, in skills/circuitjs/examples/. If the checker
ever calls one of those an error, the checker is wrong, not CircuitJS1.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))       # `python3 -m unittest toolchain/test_verdict.py` from the package

import verdict  # noqa: E402

EXAMPLES = HERE.parent / "skills" / "circuitjs" / "examples"
TEMPLATE = HERE.parent / "template" / "circuit.txt"

RC = """$ 1 0.000005 10.20027730826997 50 5 43 5e-11
v 176 224 176 112 0 1 40 5 0 0 0.5
r 176 112 336 112 0 1000
c 336 112 336 224 0 0.00001 0
w 176 224 336 224 0
g 176 224 176 256 0
o 2 64 0 2 5 0.0125
"""


def kinds(v: dict, severity: str) -> list[str]:
    return [f.get("kind") for f in v["findings"] if f["severity"] == severity]


class TestKnownGood(unittest.TestCase):
    def test_template_is_ready(self):
        v = verdict.judge(TEMPLATE.read_text(), "circuit.txt")
        self.assertTrue(v["ready"], v["summary"])
        self.assertEqual([], kinds(v, "error"))
        self.assertIn("23 elements", v["summary"])
        self.assertIn("3 scopes", v["summary"])

    def test_upstream_examples_all_parse(self):
        files = sorted(EXAMPLES.glob("*.txt"))
        self.assertEqual(9, len(files))
        for path in files:
            with self.subTest(circuit=path.name):
                v = verdict.judge(path.read_text(), path.name)
                self.assertEqual([], kinds(v, "error"))
                self.assertTrue(v["ready"])

    def test_hand_written_rc_is_clean(self):
        v = verdict.judge(RC, "circuit.txt")
        self.assertTrue(v["ready"])
        self.assertEqual([], kinds(v, "error"))
        self.assertEqual([], kinds(v, "warning"))       # every end meets another end
        self.assertEqual([{"id": "write", "name": "Write", "state": "done", "artifact": "circuit.txt"},
                          {"id": "parse", "name": "Parse", "state": "done"},
                          {"id": "run", "name": "Run", "state": "done"}], v["phases"])


class TestErrors(unittest.TestCase):
    def test_missing_file(self):
        v = verdict.judge(None, "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertEqual(["file"], kinds(v, "error"))

    def test_no_header(self):
        v = verdict.judge("r 0 0 16 0 0 1000\nr 16 0 32 0 0 1000\n", "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertIn("header", kinds(v, "error"))

    def test_unknown_element_code(self):
        v = verdict.judge(RC.replace("r 176 112", "q 176 112"), "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertEqual(["unknown_element"], kinds(v, "error"))

    def test_truncated_element(self):
        v = verdict.judge(RC.replace("c 336 112 336 224 0 0.00001 0", "c 336 112 336"), "circuit.txt")
        self.assertIn("truncated", kinds(v, "error"))

    def test_non_integer_coordinates(self):
        v = verdict.judge(RC.replace("r 176 112 336 112 0 1000", "r 176 112.5 336 112 0 1000"), "circuit.txt")
        self.assertIn("coordinates", kinds(v, "error"))

    def test_scope_points_past_the_end(self):
        v = verdict.judge(RC.replace("o 2 64 0 2 5 0.0125", "o 9 64 0 2 5 0.0125"), "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertEqual(["scope_ref"], kinds(v, "error"))

    def test_slider_points_past_the_end(self):
        v = verdict.judge(RC + "38 12 F0 0 1 101 Resistance 0\n", "circuit.txt")
        self.assertEqual(["slider_ref"], kinds(v, "error"))

    def test_unshared_slider_with_a_shared_field_loses_its_label(self):
        v = verdict.judge(RC + "38 1 F0 0 1 101 -1 Resistance 0\n", "circuit.txt")
        self.assertTrue(v["ready"])
        self.assertIn("slider_label", kinds(v, "warning"))
        ok = verdict.judge(RC + "38 1 F0 0 1 101 Resistance 0\n", "circuit.txt")
        self.assertNotIn("slider_label", kinds(ok, "warning"))
        shared = verdict.judge(RC + "38 1 F0 0 1 101 Resistance 0\n38 1 F1 0 1 101 0 Shared 0\n", "circuit.txt")
        self.assertNotIn("slider_label", kinds(shared, "warning"))

    def test_xml_dump_is_the_wrong_format(self):
        v = verdict.judge('<circuit>\n<r x="0"/>\n</circuit>\n', "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertEqual(["format"], kinds(v, "error"))

    def test_one_element_is_not_a_circuit(self):
        v = verdict.judge("$ 1 0.000005 10 50 5 43\nr 0 0 16 0 0 1000\n", "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertIn("sparse", kinds(v, "warning"))
        self.assertEqual("active", v["phases"][0]["state"])
        self.assertEqual("pending", v["phases"][1]["state"])


class TestWarnings(unittest.TestCase):
    def test_floating_end_in_an_all_two_terminal_circuit(self):
        # Move the capacitor's top end one grid square away from the resistor's.
        v = verdict.judge(RC.replace("c 336 112 336 224", "c 352 112 336 224"), "circuit.txt")
        self.assertTrue(v["ready"])                      # it still loads and runs
        self.assertIn("floating", kinds(v, "warning"))

    def test_open_end_is_only_an_info_when_a_chip_is_present(self):
        v = verdict.judge((EXAMPLES / "555square.txt").read_text(), "555square.txt")
        self.assertNotIn("floating", kinds(v, "warning"))
        self.assertIn("open_end", kinds(v, "info"))

    def test_off_grid(self):
        v = verdict.judge(RC.replace("r 176 112 336 112", "r 177 112 336 112"), "circuit.txt")
        self.assertIn("grid", kinds(v, "warning"))

    def test_small_grid_flag_allows_multiples_of_eight(self):
        small = RC.replace("$ 1 ", "$ 3 ").replace("r 176 112 336 112", "r 176 112 344 112") \
                  .replace("c 336 112 336 224", "c 344 112 336 224")
        self.assertNotIn("grid", kinds(verdict.judge(small, "circuit.txt"), "warning"))

    def test_zero_length_element(self):
        v = verdict.judge(RC.replace("r 176 112 336 112", "r 176 112 176 112"), "circuit.txt")
        self.assertIn("zero_length", kinds(v, "warning"))

    def test_rail_without_ground_is_a_warning_but_a_floating_source_is_not(self):
        rail = RC.replace("v 176 224 176 112 0 1 40 5 0 0 0.5", "R 176 112 176 80 0 0 40 5 0 0 0.5") \
                 .replace("g 176 224 176 256 0\n", "")
        self.assertIn("no_ground", kinds(verdict.judge(rail, "circuit.txt"), "warning"))
        floating = RC.replace("g 176 224 176 256 0\n", "")
        self.assertIn("no_ground", kinds(verdict.judge(floating, "circuit.txt"), "info"))

    def test_no_scope_is_an_info(self):
        v = verdict.judge(RC.replace("o 2 64 0 2 5 0.0125\n", ""), "circuit.txt")
        self.assertTrue(v["ready"])
        self.assertIn("no_scope", kinds(v, "info"))


class TestLineForms(unittest.TestCase):
    def test_blank_lines_are_skipped_and_only_the_first_options_line_counts(self):
        # The second `$` line would switch to the 8-px grid; it is ignored, so 344 stays off-grid.
        text = RC.replace("r 176 112 336 112", "r 176 112 344 112") + "\n\n$ 3 0.000005 10 50 5 43\n"
        v = verdict.judge(text, "circuit.txt")
        self.assertEqual([], kinds(v, "error"))
        self.assertIn("grid", kinds(v, "warning"))

    def test_a_short_options_line_is_an_error(self):
        v = verdict.judge(RC.replace("$ 1 0.000005 10.20027730826997 50 5 43 5e-11", "$ 1 0.000005"), "circuit.txt")
        self.assertFalse(v["ready"])
        self.assertEqual(["header"], kinds(v, "error"))

    def test_a_non_numeric_options_flag_reads_as_zero_the_16px_grid(self):
        text = RC.replace("$ 1 ", "$ x ").replace("r 176 112 336 112", "r 176 112 344 112")
        self.assertIn("grid", kinds(verdict.judge(text, "circuit.txt"), "warning"))

    def test_a_short_scope_line(self):
        v = verdict.judge(RC.replace("o 2 64 0 2 5 0.0125", "o 2 64"), "circuit.txt")
        self.assertEqual(["scope"], kinds(v, "error"))
        self.assertIn("a scope line is", v["findings"][0]["message"])

    def test_a_scope_that_names_no_element_index(self):
        v = verdict.judge(RC.replace("o 2 64 0 2 5 0.0125", "o R1 64 0 2 5 0.0125"), "circuit.txt")
        self.assertEqual(["scope"], kinds(v, "error"))
        self.assertIn("'R1'", v["findings"][0]["message"])

    def test_a_short_slider_line(self):
        v = verdict.judge(RC + "38\n", "circuit.txt")
        self.assertEqual(["slider"], kinds(v, "error"))

    def test_a_slider_that_names_no_element_index(self):
        v = verdict.judge(RC + "38 R1 F0 0 1 101 Resistance 0\n", "circuit.txt")
        self.assertEqual(["slider"], kinds(v, "error"))
        self.assertIn("'R1'", v["findings"][0]["message"])

    def test_a_shared_slider_may_carry_minus_one(self):
        v = verdict.judge(RC + "38 1 F1 0 1 101 -1 Shared 0\n", "circuit.txt")
        self.assertNotIn("slider_label", kinds(v, "warning"))

    def test_unreadable_slider_flags_read_as_unshared(self):
        v = verdict.judge(RC + "38 1 Fx 0 1 101 -1 Resistance 0\n", "circuit.txt")
        self.assertIn("slider_label", kinds(v, "warning"))


class TestMain(unittest.TestCase):
    """main(): the file it reads, the verdict it writes, what it prints, the exit code."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self.tmp.name).resolve()
        self.addCleanup(self.tmp.cleanup)

    def run_main(self, *args: str) -> tuple[int, str, dict]:
        out = io.StringIO()
        with mock.patch.object(verdict, "WS", self.ws), contextlib.redirect_stdout(out):
            code = verdict.main(["verdict.py", *args])
        return code, out.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_the_default_file_is_circuit_txt(self):
        (self.ws / "circuit.txt").write_text(RC)
        code, printed, written = self.run_main()
        self.assertEqual(0, code)
        self.assertTrue(written["ready"])
        self.assertEqual("circuit.txt", written["artifact"])
        self.assertTrue(printed.startswith("ready · circuit.txt · 5 elements · 1 scope · running"))
        self.assertIn("  info    the simulation runs in the pane", printed)

    def test_a_relative_and_an_absolute_file(self):
        (self.ws / "filters").mkdir()
        (self.ws / "filters" / "lowpass.txt").write_text(RC)
        self.assertEqual("filters/lowpass.txt", self.run_main("filters/lowpass.txt")[2]["artifact"])
        self.assertEqual("filters/lowpass.txt", self.run_main(str(self.ws / "filters" / "lowpass.txt"))[2]["artifact"])

    def test_a_missing_file_is_not_ready(self):
        code, printed, written = self.run_main()
        self.assertEqual(1, code)
        self.assertFalse(written["ready"])
        self.assertIn("not ready · circuit.txt · 1 error", printed)
        self.assertIn("  error   circuit.txt is not there yet", printed)

    def test_bytes_that_are_not_utf8_are_judged_not_a_crash(self):
        # A Latin-1 µ in a text element: before the fix read_text() raised UnicodeDecodeError, no
        # verdict was written and the header kept whatever the last good pass said.
        (self.ws / "circuit.txt").write_bytes(RC.encode() + b"x 16 16 64 16 0 12 10\xb5F cap\n")
        code, _, written = self.run_main()
        self.assertEqual(0, code)
        self.assertTrue(written["ready"])

    def test_run_as_a_script(self):
        (self.ws / "circuit.txt").write_text("r 0 0 16 0 0 1000\n")
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(self.ws)}), \
                mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(out), \
                self.assertRaises(SystemExit) as exit_:
            runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
        self.assertEqual(1, exit_.exception.code)
        self.assertIn("not ready", out.getvalue())
        self.assertFalse(json.loads((self.ws / ".harness" / "verdict.json").read_text())["ready"])


class TestShape(unittest.TestCase):
    def test_verdict_conforms_to_spec_1(self):
        v = verdict.judge(RC, "circuit.txt")
        self.assertEqual(1, v["spec"])
        self.assertIsInstance(v["ready"], bool)
        self.assertLessEqual(len(v["summary"]), 200)
        self.assertEqual("circuit.txt", v["artifact"])
        self.assertLessEqual(len(v["phases"]), 12)
        for p in v["phases"]:
            self.assertIn(p["state"], {"done", "active", "pending", "failed"})
        for f in v["findings"]:
            self.assertIn(f["severity"], {"error", "warning", "info"})
            self.assertTrue(f["message"])
        self.assertRegex(v["updatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_element_code_tables_do_not_overlap(self):
        groups = [verdict.TWO_POST, verdict.ONE_POST, verdict.NO_POST, verdict.COMPUTED_PINS]
        for i, a in enumerate(groups):
            for b in groups[i + 1:]:
                self.assertEqual(set(), a & b)
        self.assertEqual(set(), verdict.KNOWN & verdict.NON_ELEMENT)


if __name__ == "__main__":
    unittest.main()
