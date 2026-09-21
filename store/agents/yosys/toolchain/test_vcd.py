"""The VCD reader, on a dump shaped exactly like Icarus Verilog's."""
import io
import json
import runpy
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import vcd2json  # noqa: E402
from vcd2json import extend, main, parse, tick_fs  # noqa: E402

SCRIPT = Path(__file__).parent / "vcd2json.py"

DUMP = """$date
\tWed Sep 16 13:10:58 2026
$end
$version
\tIcarus Verilog
$end
$timescale
\t1ps
$end
$scope module blink_tb $end
$var wire 1 ! ledg_n $end
$var parameter 32 # HALF $end
$var reg 1 ( clk $end
$var integer 32 + toggles [31:0] $end
$scope module dut $end
$var wire 1 ! ledg_n $end
$var reg 3 0 count [2:0] $end
$upscope $end
$scope task check $end
$var reg 320 3 what [319:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
$comment Show the parameter values. $end
$dumpall
b1000 #
$end
#0
$dumpvars
0(
1!
b0 0
b0 +
bx 3
$end
#5000
1(
b1 0
#10000
0(
b10 0
#15000
1(
0!
b11 0
b1 +
"""


class Header(unittest.TestCase):
    def setUp(self):
        self.w = parse(DUMP)
        self.by_name = {s["name"]: s for s in self.w["signals"]}

    def test_timescale(self):
        self.assertEqual(self.w["timescale"], "1ps")
        self.assertEqual(self.w["tickFs"], 1000)

    def test_parameters_are_not_waveforms(self):
        self.assertNotIn("blink_tb.HALF", self.by_name)

    def test_task_scopes_are_skipped(self):
        # Icarus dumps a task's arguments, including 320-bit string literals. Not a signal.
        self.assertFalse(any("what" in n for n in self.by_name))

    def test_names_are_scoped_and_one_lane_per_net(self):
        self.assertEqual([s["name"] for s in self.w["signals"]],
                         ["blink_tb.ledg_n", "blink_tb.clk", "blink_tb.toggles", "blink_tb.dut.count"])
        self.assertEqual(self.by_name["blink_tb.ledg_n"]["aliases"], ["blink_tb.dut.ledg_n"])

    def test_widths(self):
        self.assertEqual(self.by_name["blink_tb.dut.count"]["width"], 3)
        self.assertEqual(self.by_name["blink_tb.clk"]["width"], 1)


class Changes(unittest.TestCase):
    def setUp(self):
        self.w = parse(DUMP)
        self.by_name = {s["name"]: s for s in self.w["signals"]}

    def test_end_is_the_last_timestamp(self):
        self.assertEqual(self.w["end"], 15000)

    def test_scalar_edges(self):
        self.assertEqual(self.by_name["blink_tb.clk"]["changes"],
                         [[0, "0"], [5000, "1"], [10000, "0"], [15000, "1"]])

    def test_bus_values_are_extended_to_full_width(self):
        self.assertEqual(self.by_name["blink_tb.dut.count"]["changes"],
                         [[0, "000"], [5000, "001"], [10000, "010"], [15000, "011"]])

    def test_wide_bus_is_padded_not_truncated(self):
        self.assertEqual(self.by_name["blink_tb.toggles"]["changes"][1], [15000, "0" * 31 + "1"])

    def test_a_repeated_value_is_not_an_edge(self):
        w = parse(DUMP + "#20000\n1(\n")
        clk = next(s for s in w["signals"] if s["name"] == "blink_tb.clk")
        self.assertEqual(clk["changes"][-1], [15000, "1"])


    def test_a_same_tick_rewrite_keeps_the_last_value(self):
        w = parse(DUMP + "#20000\n0(\n#20000\nz(\n")
        clk = next(s for s in w["signals"] if s["name"] == "blink_tb.clk")
        self.assertEqual(clk["changes"][-1], [20000, "z"])

    def test_a_same_tick_glitch_back_to_the_old_value_is_no_edge(self):
        # 0 then 1 at #20000 on a clock that was already 1: nothing changed at that tick.
        w = parse(DUMP + "#20000\n0(\n1(\n")
        clk = next(s for s in w["signals"] if s["name"] == "blink_tb.clk")
        self.assertEqual(clk["changes"], [[0, "0"], [5000, "1"], [10000, "0"], [15000, "1"]])

    def test_reals_are_kept_as_written(self):
        w = parse("$var real 1 ! temp $end $enddefinitions $end #0 r1.5 ! #3 R2.25e1 !")
        self.assertEqual(w["signals"][0]["changes"], [[0, "1.5"], [3, "2.25e1"]])

    def test_a_bad_timestamp_is_ignored(self):
        w = parse("$var wire 1 ! a $end $enddefinitions $end #0 0! #oops 1! #7 0!")
        self.assertEqual(w["signals"][0]["changes"], [[0, "1"], [7, "0"]])
        self.assertEqual(w["end"], 7)

    def test_changes_for_an_undeclared_id_are_ignored(self):
        w = parse("$var wire 1 ! a $end $enddefinitions $end #0 0! 1? b101 ?")
        self.assertEqual(w["signals"][0]["changes"], [[0, "0"]])

    def test_a_long_run_is_capped_and_says_so(self):
        with mock.patch.object(vcd2json, "MAX_CHANGES", 3):
            w = parse("$var wire 1 ! a $end $enddefinitions $end #0 0! #1 1! #2 0! #3 1! #4 0!")
        self.assertEqual(w["signals"][0]["changes"], [[0, "0"], [1, "1"], [2, "0"]])
        self.assertTrue(w["truncated"])
        self.assertFalse(parse(DUMP)["truncated"])


class Declarations(unittest.TestCase):
    def test_a_header_with_no_enddefinitions_still_lists_its_signals(self):
        w = parse("$timescale 10 ns $end $scope module a $end $var wire 1 ! x $end")
        self.assertEqual([s["name"] for s in w["signals"]], ["a.x"])
        self.assertEqual((w["end"], w["tickFs"]), (0, 10 ** 7))

    def test_an_unbalanced_upscope_and_stray_tokens_do_not_derail_the_header(self):
        w = parse("$upscope $end stray $scope module top $end $var wire 1 ! x $end $upscope $end "
                  "$var wire 1 # y $end $enddefinitions $end")
        self.assertEqual([s["name"] for s in w["signals"]], ["top.x", "y"])

    def test_a_module_inside_a_task_is_still_skipped(self):
        w = parse("$scope module top $end $scope task t $end $scope module inner $end $var wire 1 ! a $end "
                  "$upscope $end $upscope $end $var wire 1 # b $end $upscope $end $enddefinitions $end")
        self.assertEqual([s["name"] for s in w["signals"]], ["top.b"])

    def test_short_vars_bad_widths_and_wide_buses_are_dropped(self):
        w = parse("$var wire 1 ! $end $var wire wide # a $end $var wire 0 $ b $end $var reg 65 % mem $end "
                  "$var wire 64 & bus $end $enddefinitions $end")
        self.assertEqual([(s["name"], s["width"]) for s in w["signals"]], [("bus", 64)])

    def test_no_more_lanes_than_the_pane_can_show(self):
        header = " ".join(f"$var wire 1 s{k} n{k} $end" for k in range(vcd2json.MAX_SIGNALS + 5))
        w = parse(header + " $enddefinitions $end")
        self.assertEqual(len(w["signals"]), vcd2json.MAX_SIGNALS)
        self.assertEqual(w["signals"][-1]["name"], f"n{vcd2json.MAX_SIGNALS - 1}")


class Main(unittest.TestCase):
    def run_main(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_usage(self):
        code, _, err = self.run_main(["vcd2json.py"])
        self.assertEqual(code, 2)
        self.assertIn("usage: vcd2json.py", err)

    def test_a_missing_vcd_says_what_the_testbench_forgot(self):
        with tempfile.TemporaryDirectory() as d:
            code, _, err = self.run_main(["vcd2json.py", str(Path(d) / "sim.vcd")])
        self.assertEqual(code, 1)
        self.assertIn("did the testbench call $dumpfile/$dumpvars?", err)

    def test_writes_the_lanes_beside_the_vcd_or_where_asked(self):
        with tempfile.TemporaryDirectory() as d:
            vcd = Path(d) / "sim.vcd"
            vcd.write_text(DUMP)
            code, out, _ = self.run_main(["vcd2json.py", str(vcd)])
            self.assertEqual(code, 0)
            self.assertEqual(len(json.loads((Path(d) / "sim.json").read_text())["signals"]), 4)
            self.assertIn("4 signal(s), 12 change(s), 0..15000 1ps", out)
            dst = Path(d) / "deeper" / "waves.json"
            code, out, _ = self.run_main(["vcd2json.py", str(vcd), str(dst)])
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(dst.read_text())["end"], 15000)

    def test_runs_as_a_script(self):
        with tempfile.TemporaryDirectory() as d:
            vcd = Path(d) / "sim.vcd"
            vcd.write_text(DUMP)
            with mock.patch.object(sys, "argv", [str(SCRIPT), str(vcd), str(Path(d) / "w.json")]), \
                    redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as exit_:
                runpy.run_path(str(SCRIPT), run_name="__main__")
            self.assertEqual(exit_.exception.code, 0)
            self.assertTrue((Path(d) / "w.json").exists())


class Extend(unittest.TestCase):
    def test_zero_extends(self):
        self.assertEqual(extend("1", 4), "0001")

    def test_x_and_z_extend_with_themselves(self):
        self.assertEqual(extend("x", 4), "xxxx")
        self.assertEqual(extend("z0", 4), "zzz0")

    def test_already_wide_enough(self):
        self.assertEqual(extend("1010", 4), "1010")


class Timescale(unittest.TestCase):
    def test_units(self):
        self.assertEqual(tick_fs("1ps"), 1000)
        self.assertEqual(tick_fs("10 ns"), 10 ** 7)
        self.assertEqual(tick_fs("1 fs"), 1)

    def test_nonsense_falls_back_to_a_picosecond(self):
        self.assertEqual(tick_fs("whenever"), 1000)


if __name__ == "__main__":
    unittest.main()
