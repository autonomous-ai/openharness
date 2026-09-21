"""The judge, without a toolchain: every fixture below is real output from iverilog, yosys or
nextpnr, trimmed. `python3 -m unittest discover -s toolchain`."""
import io
import json
import os
import runpy
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import verdict  # noqa: E402
from verdict import (assemble, load_json, parse_pnr_log, parse_pnr_report, parse_sim_log,  # noqa: E402
                     parse_yosys_log, read_step, to_verdict)

SCRIPT = Path(__file__).parent / "verdict.py"

DONE = {"state": "done", "exit": 0}
FAILED = {"state": "failed", "exit": 1}
ALL_DONE = {k: dict(DONE) for k in ("sim", "waves", "synth", "schematic", "svg", "pnr", "pack")}

PNR = {
    "fmax": {"clk$SB_IO_IN_$glb_clk": {"achieved": 64.80461883544922, "constraint": 12.00004768371582}},
    "utilization": {
        "ICESTORM_LC": {"available": 5280, "used": 36},
        "SB_IO": {"available": 39, "used": 4},
        "SB_GB": {"available": 8, "used": 1},
        "ICESTORM_RAM": {"available": 30, "used": 0},
        "ICESTORM_DSP": {"available": 8, "used": 0},
    },
}

STAT = """
2.51. Executing CHECK pass (checking for obvious problems).

3. Printing statistics.

=== blink ===

        +----------Local Count, excluding submodules.
        |
       54 wires
       83 wire bits
        4 ports
       77 cells
       21   SB_CARRY
        1   SB_DFFE
       23   SB_DFFSR
       32   SB_LUT4

End of script.
"""


BITSTREAM = {"path": "out/blink.bin", "bytes": 104090, "flash": "iceprog out/blink.bin"}


def build(steps=None, sim=None, synth=None, pnr=None, bitstream=BITSTREAM, rtl=("rtl/blink.v",)):
    return assemble(
        "blink", steps if steps is not None else dict(ALL_DONE), list(rtl),
        sim if sim is not None else {"checks": ["PASS blink"], "failures": [], "asserted": True, "diagnostics": []},
        synth if synth is not None else {"cells": 77, "byType": {"SB_LUT4": 32}, "diagnostics": []},
        pnr if pnr is not None else {**parse_pnr_report(PNR), "diagnostics": []},
        bitstream,
        {"signals": [{"name": "clk"}], "end": 985000}, "--up5k", "sg48", "out/blink.svg",
    )


class SimLog(unittest.TestCase):
    def test_pass_and_checks(self):
        s = parse_sim_log("  ok   red LED dark\n  ok   green LED toggled\nPASS  blink: 12 toggles\n")
        self.assertTrue(s["asserted"])
        self.assertEqual(s["failures"], [])
        self.assertEqual(len(s["checks"]), 3)

    def test_fail_is_seen(self):
        s = parse_sim_log("  FAIL green LED toggled once per half period (at 480000)\nFAIL  blink: 1 check failed\n")
        self.assertEqual(len(s["failures"]), 2)

    def test_iverilog_error_carries_its_place(self):
        s = parse_sim_log("tb/blink_tb.v:47: syntax error\nrtl/blink.v:19: error: Unknown module type: countr\n")
        self.assertEqual(s["diagnostics"], [
            {"severity": "error", "message": "Unknown module type: countr", "ref": "rtl/blink.v:19"}])

    def test_a_dump_with_no_assertion_is_not_a_test(self):
        self.assertFalse(parse_sim_log("VCD info: dumpfile out/sim.vcd opened\n")["asserted"])

    def test_a_passing_check_that_mentions_failure_is_not_a_failure(self):
        s = parse_sim_log("  ok   no failure after reset\n  ok   parity flagged on a failed frame\n"
                          "PASS  uart: 2 checks\n")
        self.assertEqual(s["failures"], [])
        self.assertTrue(s["asserted"])

    def test_the_word_FAIL_anywhere_in_a_check_line_still_fails_it(self):
        s = parse_sim_log("  ok   3 frames, FAIL on the fourth\n")
        self.assertEqual(s["failures"], ["ok   3 frames, FAIL on the fourth"])


class YosysLog(unittest.TestCase):
    def test_stat_gives_cells_and_types(self):
        y = parse_yosys_log(STAT)
        self.assertEqual(y["cells"], 77)
        self.assertEqual(y["byType"], {"SB_LUT4": 32, "SB_DFFSR": 23, "SB_CARRY": 21, "SB_DFFE": 1})

    def test_byType_is_ordered_by_count(self):
        self.assertEqual(list(parse_yosys_log(STAT)["byType"])[0], "SB_LUT4")

    def test_latch_warning_is_its_own_kind(self):
        y = parse_yosys_log(r"Warning: Latch inferred for signal `\bad.\y' from process")
        self.assertEqual(y["diagnostics"][0]["kind"], "latch")
        self.assertEqual(y["diagnostics"][0]["severity"], "warning")

    def test_a_stat_block_without_counts(self):
        y = parse_yosys_log("=== empty ===\n\n   Number of ports: 0\n")
        self.assertEqual((y["cells"], y["wires"], y["byType"]), (0, 0, {}))
        self.assertEqual(parse_yosys_log("no statistics here")["cells"], 0)

    def test_error_is_an_error(self):
        y = parse_yosys_log("ERROR: Multiple conflicting drivers for bad.\\y")
        self.assertEqual(y["diagnostics"][0]["severity"], "error")
        self.assertEqual(y["diagnostics"][0]["kind"], "driver")


class PnrReport(unittest.TestCase):
    def test_fmax_against_the_constraint(self):
        c = parse_pnr_report(PNR)["clocks"][0]
        self.assertEqual((c["clock"], c["achievedMHz"], c["constraintMHz"], c["pass"]), ("clk", 64.8, 12.0, True))

    def test_a_missed_clock_does_not_pass(self):
        slow = {"fmax": {"clk$x": {"achieved": 9.5, "constraint": 12.0}}, "utilization": {}}
        self.assertFalse(parse_pnr_report(slow)["clocks"][0]["pass"])

    def test_logic_cells_come_first_and_unused_resources_are_dropped(self):
        util = parse_pnr_report(PNR)["utilization"]
        self.assertEqual([u["id"] for u in util], ["ICESTORM_LC", "SB_IO", "SB_GB"])
        self.assertEqual(util[0]["percent"], round(3600 / 5280, 2))
        self.assertEqual(util[0]["name"], "Logic cells")


class PnrLog(unittest.TestCase):
    def test_errors_and_warnings_with_or_without_the_info_prefix(self):
        d = parse_pnr_log("Info: placing\nERROR: IO 'tx' is unconstrained\nInfo: Warning: timing is tight\n")
        self.assertEqual(d, [
            {"severity": "error", "kind": "nextpnr", "message": "IO 'tx' is unconstrained"},
            {"severity": "warning", "kind": "nextpnr", "message": "timing is tight"}])


class Assemble(unittest.TestCase):
    def test_a_clean_run_is_ready(self):
        r = build()
        self.assertTrue(r["ready"])
        self.assertEqual(r["findings"], [])
        self.assertEqual([p["state"] for p in r["phases"]], ["done"] * 5)
        self.assertIn("bitstream ready", r["summary"])
        self.assertIn("64.8 MHz", r["summary"])
        self.assertIn("36/5280 LCs", r["summary"])

    def test_a_failing_testbench_is_not_ready(self):
        sim = parse_sim_log("  FAIL red LED dark (at 5000)\n  FAIL green toggled (at 9000)\n"
                            "FAIL  blink: 2 checks failed\n")
        r = build(sim=sim, bitstream=None)
        self.assertFalse(r["ready"])
        # vvp returned 0, but the testbench said no: the phase strip must show that.
        self.assertEqual(r["phases"][1]["state"], "failed")
        self.assertEqual(r["findings"][0]["kind"], "testbench")
        # Three FAIL lines, but the last is the testbench's own tally, not a third check.
        self.assertIn("2 failing checks", r["summary"])
        self.assertEqual(len(r["findings"]), 3)

    def test_pending_steps_read_as_pending_not_failed(self):
        steps = {"sim": dict(DONE), "waves": dict(DONE)}
        r = build(steps=steps, pnr={"utilization": [], "clocks": [], "diagnostics": []},
                  synth={"cells": 0, "byType": {}, "diagnostics": []}, bitstream=None)
        self.assertEqual([p["state"] for p in r["phases"]], ["done", "done", "pending", "pending", "pending"])
        self.assertFalse(r["ready"])

    def test_a_missed_clock_is_an_error_finding(self):
        slow = {**parse_pnr_report({"fmax": {"clk$x": {"achieved": 9.5, "constraint": 12.0}}, "utilization": {}}),
                "diagnostics": []}
        r = build(pnr=slow)
        self.assertFalse(r["ready"])
        self.assertEqual(r["findings"][0]["kind"], "timing")
        self.assertIn("9.5 MHz", r["findings"][0]["message"])

    def test_a_nearly_full_chip_warns_but_still_ships(self):
        full = {**parse_pnr_report({"fmax": {}, "utilization": {"ICESTORM_LC": {"used": 5200, "available": 5280}}}),
                "diagnostics": []}
        r = build(pnr=full)
        self.assertTrue(r["ready"])
        self.assertEqual(r["findings"][0]["severity"], "warning")
        self.assertIn("nearly full", r["findings"][0]["message"])

    def test_a_testbench_that_asserts_nothing_warns(self):
        sim = {"checks": [], "failures": [], "asserted": False, "diagnostics": []}
        r = build(sim=sim)
        self.assertTrue(r["ready"])  # it builds; it is just not proven
        self.assertEqual(r["findings"][0]["severity"], "warning")
        self.assertIn("never printed PASS or FAIL", r["findings"][0]["message"])

    def test_no_rtl_at_all(self):
        r = build(steps={}, rtl=(), bitstream=None)
        self.assertFalse(r["ready"])
        self.assertEqual(r["phases"][0]["state"], "active")
        self.assertEqual(r["findings"][0]["kind"], "rtl")

    def test_a_step_that_failed_silently_still_explains_itself(self):
        # nextpnr missing from PATH prints nothing a parser recognises; the phase must not go red
        # with no reason beside it.
        steps = {**ALL_DONE, "pnr": {"state": "failed", "exit": 127, "log": "out/logs/pnr.log",
                                     "tail": "nextpnr-ice40 is not installed - run toolchain/setup.sh"},
                 "pack": {"state": "failed", "exit": 127, "log": "out/logs/pack.log", "tail": ""}}
        r = build(steps=steps, pnr={"utilization": [], "clocks": [], "diagnostics": []}, bitstream=None)
        self.assertFalse(r["ready"])
        messages = [f["message"] for f in r["findings"]]
        self.assertIn("nextpnr-ice40 is not installed - run toolchain/setup.sh", messages)
        self.assertIn("bitstream failed — see out/logs/pack.log", messages)
        self.assertEqual([p["state"] for p in r["phases"]], ["done", "done", "done", "failed", "failed"])

    def test_a_parsed_failure_is_not_repeated_as_a_log_tail(self):
        steps = {**ALL_DONE, "synth": {"state": "failed", "exit": 1, "log": "out/logs/synth.log",
                                       "tail": "ERROR: Found 1 problems in 'check -assert'."}}
        synth = {"cells": 0, "byType": {}, "diagnostics": [
            {"severity": "error", "kind": "yosys", "message": "Found 1 problems in 'check -assert'."}]}
        r = build(steps=steps, synth=synth, bitstream=None)
        self.assertEqual(len([f for f in r["findings"] if "check -assert" in f["message"]]), 1)

    def test_verilog_diagnostics_are_findings_on_their_line(self):
        sim = parse_sim_log("rtl/blink.v:19: error: Unknown module type: countr\n")
        steps = {**ALL_DONE, "sim": {"state": "failed", "exit": 1, "log": "out/logs/sim.log", "tail": "1 error(s)"}}
        r = build(steps=steps, sim=sim, bitstream=None)
        self.assertEqual(r["findings"][0], {"severity": "error", "kind": "verilog",
                                            "message": "Unknown module type: countr", "ref": "rtl/blink.v:19"})
        # the parsed error explains the red phase; the log's last line is not added on top
        self.assertEqual(len(r["findings"]), 1)
        self.assertEqual(r["phases"][1]["state"], "failed")
        self.assertTrue(r["summary"].endswith("1 error"))

    def test_a_simulation_that_did_not_finish_says_so(self):
        steps = {**ALL_DONE, "sim": {"state": "failed", "exit": 1, "log": "out/logs/sim.log"}}
        r = build(steps=steps, sim={"checks": [], "failures": [], "asserted": False, "diagnostics": []},
                  bitstream=None)
        self.assertEqual(r["findings"][0]["kind"], "simulation")
        self.assertIn("simulation did not finish", r["findings"][0]["message"])
        self.assertIsNone(r["simulation"]["vcd"])

    def test_nextpnr_errors_point_at_the_constraints(self):
        steps = {**ALL_DONE, "pnr": dict(FAILED), "pack": {"state": "skipped"}}
        pnr = {"utilization": [], "clocks": [], "diagnostics": parse_pnr_log("ERROR: IO 'tx' is unconstrained\n")}
        r = build(steps=steps, pnr=pnr, bitstream=None)
        self.assertEqual(r["findings"], [{"severity": "error", "kind": "nextpnr", "message": "IO 'tx' is unconstrained",
                                          "ref": "constraints/blink.pcf"}])
        self.assertEqual(r["summary"], "blink · sim passes · 77 cells · 1 error")

    def test_a_running_step_makes_its_phase_active(self):
        steps = {"sim": dict(DONE), "waves": dict(DONE), "synth": {"state": "running", "log": "out/logs/synth.log"}}
        r = build(steps=steps, pnr={"utilization": [], "clocks": [], "diagnostics": []}, bitstream=None)
        self.assertEqual([p["state"] for p in r["phases"]], ["done", "done", "active", "pending", "pending"])

    def test_several_errors_are_counted_in_the_summary(self):
        steps = {**ALL_DONE, "synth": dict(FAILED), "pnr": dict(FAILED)}
        r = build(steps=steps, bitstream=None)
        self.assertTrue(r["summary"].endswith("2 errors"))

    def test_a_latch_finding_explains_itself(self):
        synth = {"cells": 4, "byType": {}, "diagnostics": [
            {"severity": "warning", "kind": "latch", "message": r"Latch inferred for signal `\bad.\y'"}]}
        r = build(synth=synth)
        self.assertIn("infers a latch", r["findings"][0]["message"])


class Verdict(unittest.TestCase):
    def test_shape_is_spec_1(self):
        v = to_verdict(build(), "out/blink.report.json")
        self.assertEqual(v["spec"], 1)
        self.assertIs(v["ready"], True)
        self.assertEqual(v["artifact"], "out/blink.report.json")
        self.assertLessEqual(len(v["summary"]), 200)
        self.assertLessEqual(len(v["phases"]), 12)
        for p in v["phases"]:
            self.assertIn(p["state"], {"done", "active", "pending", "failed"})
            self.assertLessEqual(len(p["name"]), 40)
        for f in v["findings"]:
            self.assertIn(f["severity"], {"error", "warning", "info"})
            self.assertTrue(f["message"])
        self.assertRegex(v["updatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_summary_is_capped(self):
        sim = {"checks": [], "failures": ["FAIL " + "x" * 400], "asserted": True, "diagnostics": []}
        self.assertLessEqual(len(to_verdict(build(sim=sim), "a")["summary"]), 200)


class LoadJson(unittest.TestCase):
    def test_missing_or_broken_json_is_none(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertIsNone(load_json(Path(d) / "nope.json"))
            (Path(d) / "bad.json").write_text("{not json")
            self.assertIsNone(load_json(Path(d) / "bad.json"))
            (Path(d) / "ok.json").write_text('{"a": 1}')
            self.assertEqual(load_json(Path(d) / "ok.json"), {"a": 1})


class Steps(unittest.TestCase):
    """What flow.sh leaves beside each log: <step>.start, <step>.time, <step>.exit."""

    def test_running_done_failed_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            logs = Path(d)
            (logs / "sim.start").write_text("1000\n")
            (logs / "sim.time").write_text("1000 1750\n")
            (logs / "sim.exit").write_text("0\n")
            (logs / "sim.log").write_text("PASS\n")
            (logs / "synth.start").write_text("2000\n")
            (logs / "synth.log").write_text("")
            (logs / "pnr.exit").write_text("1\n")
            (logs / "pnr.log").write_text("Info: placing\nERROR: IO 'tx' is unconstrained\n")
            sim = read_step(logs, "sim", finished=False)
            self.assertEqual((sim["state"], sim["startedAt"], sim["seconds"]), ("done", 1000, 0.75))
            self.assertEqual(read_step(logs, "synth", finished=False)["state"], "running")
            pnr = read_step(logs, "pnr", finished=True)
            self.assertEqual((pnr["state"], pnr["tail"]), ("failed", "ERROR: IO 'tx' is unconstrained"))
            self.assertEqual(read_step(logs, "pack", finished=False), {"state": "pending"})
            self.assertEqual(read_step(logs, "pack", finished=True), {"state": "skipped"})

    def test_a_skipped_step_is_a_pending_phase(self):
        steps = dict(ALL_DONE)
        steps["synth"] = dict(FAILED)
        steps["pnr"] = {"state": "skipped"}
        steps["pack"] = {"state": "skipped"}
        r = build(steps=steps, bitstream=None)
        phases = {p["id"]: p["state"] for p in r["phases"]}
        self.assertEqual((phases["synthesize"], phases["pnr"], phases["bitstream"]), ("failed", "pending", "pending"))
        self.assertFalse(r["ready"])


def workspace(root: Path, *, top="blink", pack=True, pnr_ok=True):
    """A workspace as flow.sh leaves it after a whole run."""
    logs = root / "out" / "logs"
    logs.mkdir(parents=True)
    (root / "rtl").mkdir()
    (root / "rtl" / f"{top}.v").write_text("module blink; endmodule\n")
    (root / "out" / ".top").write_text(top + "\n")
    (logs / "run.json").write_text(json.dumps({"top": top, "pid": 1, "startedAt": 1000, "finishedAt": 9000}))
    for k, sid in enumerate(("sim", "waves", "synth", "schematic", "svg", "pnr", "pack")):
        if sid == "pack" and not pack:
            continue
        failed = sid == "pnr" and not pnr_ok
        (logs / f"{sid}.start").write_text(f"{1000 + k}\n")
        (logs / f"{sid}.time").write_text(f"{1000 + k} {1500 + k}\n")
        (logs / f"{sid}.exit").write_text("1\n" if failed else "0\n")
        (logs / f"{sid}.log").write_text({"sim": "  ok   one\nPASS  blink\n", "synth": STAT}.get(sid, "")
                                         + ("ERROR: IO 'tx' is unconstrained\n" if failed else ""))
    (root / "out" / f"{top}_pnr.json").write_text(json.dumps(PNR))
    (root / "out" / f"{top}_routed.json").write_text("{}")
    (root / "out" / f"{top}.svg").write_text("<svg/>")
    (root / "out" / f"{top}.bin").write_bytes(b"\0" * 32)
    (root / "out" / "waves.json").write_text(json.dumps({"signals": [{"name": "clk"}, {"name": "led"}]}))


class Main(unittest.TestCase):
    """The whole read: out/ as flow.sh leaves it -> out/<top>.report.json and .harness/verdict.json."""

    def run_main(self, root: Path, argv):
        out = io.StringIO()
        with mock.patch.object(verdict, "WS", root), redirect_stdout(out):
            code = verdict.main(argv)
        return code, out.getvalue()

    def test_a_finished_run_is_ready_and_writes_both_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            workspace(root)
            code, out = self.run_main(root, ["verdict.py", "blink"])
            self.assertEqual(code, 0)
            self.assertTrue(out.startswith("ready · blink · sim passes · 77 cells"), out)
            report = json.loads((root / "out" / "blink.report.json").read_text())
            self.assertEqual(report["bitstream"], {"path": "out/blink.bin", "bytes": 32, "flash": "iceprog out/blink.bin"})
            self.assertEqual((report["pnr"]["report"], report["pnr"]["routed"]), ("out/blink_pnr.json", "out/blink_routed.json"))
            self.assertEqual(report["synthesis"]["schematic"], "out/blink.svg")
            self.assertEqual(report["simulation"]["signals"], 2)
            self.assertEqual(report["steps"][0]["seconds"], 0.5)
            self.assertEqual(report["board"]["device"], "iCE40 UP5K")
            v = json.loads((root / ".harness" / "verdict.json").read_text())
            self.assertEqual((v["ready"], v["artifact"]), (True, "out/blink.report.json"))

    def test_the_top_comes_from_out_dot_top_then_the_testbench_then_a_default(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            workspace(root)
            self.assertEqual(self.run_main(root, ["verdict.py"])[0], 0)
            (root / "out" / ".top").unlink()
            (root / "tb").mkdir()
            (root / "tb" / "uart_tb.v").write_text("")
            code, out = self.run_main(root, ["verdict.py"])
            self.assertTrue((root / "out" / "uart.report.json").exists())
            self.assertTrue(out.startswith("ready · uart · sim passes"), out)
            self.assertNotIn("bitstream ready", out)  # there is no out/uart.bin
        with tempfile.TemporaryDirectory() as d:
            code, out = self.run_main(Path(d), ["verdict.py"])
            self.assertEqual(code, 1)
            self.assertIn("not ready · top", out)
            self.assertIn("  error   no rtl/*.v — nothing to build", out)
            v = json.loads((Path(d) / ".harness" / "verdict.json").read_text())
            self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending", "pending", "pending"])

    def test_a_failed_place_and_route_reads_its_log_and_ships_no_bitstream(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            workspace(root, pnr_ok=False, pack=False)
            (root / "out" / "blink_routed.json").unlink()
            (root / "out" / "blink_pnr.json").unlink()
            code, out = self.run_main(root, ["verdict.py", "blink"])
            self.assertEqual(code, 1)
            self.assertIn("  error   IO 'tx' is unconstrained  (constraints/blink.pcf)", out)
            report = json.loads((root / "out" / "blink.report.json").read_text())
            self.assertIsNone(report["bitstream"])
            self.assertIsNone(report["pnr"]["routed"])
            self.assertEqual(report["steps"][-1]["state"], "skipped")

    def test_runs_as_a_script_on_the_harness_workspace(self):
        with tempfile.TemporaryDirectory() as d:
            workspace(Path(d))
            with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": d, "YOSYS_DEVICE": "--hx8k"}), \
                    mock.patch.object(sys, "argv", [str(SCRIPT), "blink"]), redirect_stdout(io.StringIO()), \
                    self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(SCRIPT), run_name="__main__")
            self.assertEqual(exit_.exception.code, 0)
            report = json.loads((Path(d) / "out" / "blink.report.json").read_text())
            self.assertEqual(report["board"]["device"], "iCE40 HX8K")


if __name__ == "__main__":
    unittest.main()
