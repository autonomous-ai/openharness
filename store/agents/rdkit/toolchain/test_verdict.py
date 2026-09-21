"""The judge, without RDKit: `python3 -m unittest toolchain/test_verdict.py` on any Python 3.10+. The
tests that read SDFs with RDKit run under "$RDKIT_PYTHON" and skip elsewhere."""
import contextlib, io, json, os, runpy, sys, tempfile, time, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import inspect, judge, newest_sdf

try:
    import rdkit  # noqa: F401
    HAS_RDKIT = True
except ImportError:
    HAS_RDKIT = False

REPORT = {"name": "caffeine", "formula": "C8H10N4O2", "atoms": 24, "conformers": 1,
          "energies": {"forcefield": "MMFF94", "before": 91.2, "final": 28.4}, "violations": [],
          "properties": {"mw": 194.19, "logp": -1.03, "lipinski_violations": 0}}
SDF = {"path": "out/caffeine.sdf", "conformers": 1, "atoms": 24, "error": None}


class Judge(unittest.TestCase):
    def test_a_designed_and_embedded_molecule_is_ready(self):
        v = judge(True, REPORT, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["artifact"], "out/caffeine.sdf")
        self.assertEqual(v["summary"], "caffeine · C8H10N4O2 · MW 194.19 · cLogP -1.03 · 1 conformer · MMFF94 28.4 kcal/mol")
        self.assertEqual(v["findings"], [])

    def test_nothing_yet(self):
        v = judge(False, None, None)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual(v["summary"], "no design yet")

    def test_a_script_without_a_report_is_still_designing(self):
        v = judge(True, None, None)
        self.assertEqual(v["summary"], "no molecule yet")
        self.assertEqual(v["phases"][0]["state"], "active")

    def test_an_sdf_that_does_not_parse_fails_embed(self):
        v = judge(True, REPORT, {"path": "out/x.sdf", "conformers": 0, "atoms": 0, "error": "bad valence"})
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0]["severity"], "error")
        self.assertIsNone(v["artifact"])

    def test_a_flat_sdf_has_no_conformer(self):
        v = judge(True, REPORT, {"path": "out/x.sdf", "conformers": 0, "atoms": 24, "error": None})
        self.assertFalse(v["ready"])
        self.assertIn("no conformer", v["findings"][0]["message"])

    def test_lipinski_violations_are_warnings_not_a_gate(self):
        report = {**REPORT, "violations": ["mw 612.3 > 500", "logp 6.1 > 5"]}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual([f["severity"] for f in v["findings"]], ["warning", "warning"])
        self.assertTrue(v["summary"].endswith("2 warnings"))

    def test_a_strained_conformer_warns(self):
        report = {**REPORT, "energies": {"forcefield": "MMFF94", "before": 900.0, "final": 480.0}}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual(v["findings"][0]["kind"], "energy")
        self.assertIn("strained", v["findings"][0]["message"])

    def test_an_unminimised_conformer_is_only_noted(self):
        report = {**REPORT, "energies": {"forcefield": None, "before": None, "final": None}}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual(v["findings"][0]["severity"], "info")

    def test_veber_alerts_and_stereo_are_reported_not_gated(self):
        report = {**REPORT, "veber": ["rotatable_bonds 17 > 10"], "alerts": ["Brenk: Aliphatic long chain"],
                  "unspecified_stereocenters": 1}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual([(f["kind"], f["severity"]) for f in v["findings"]],
                         [("veber", "warning"), ("alert", "warning"), ("stereo", "info")])
        self.assertTrue(v["summary"].endswith("2 warnings"))

    def test_an_analogue_names_its_parent_and_the_change(self):
        report = {**REPORT, "name": "caffeine_ethyl", "parent": {"name": "caffeine", "change": "+C", "similarity": 0.55}}
        v = judge(True, report, {**SDF, "conformers": 6})
        self.assertTrue(v["summary"].startswith("caffeine_ethyl (+C vs caffeine) · C8H10N4O2"))
        self.assertIn("6 conformers", v["summary"])

    def test_a_report_without_mw_or_logp_leaves_them_out_of_the_summary(self):
        report = {**REPORT, "properties": {}}
        v = judge(True, report, SDF)
        self.assertEqual(v["summary"], "caffeine · C8H10N4O2 · 1 conformer · MMFF94 28.4 kcal/mol")


def mol_block(name, atoms, bonds):
    """A V2000 record: atoms as (symbol, x, y, z), bonds as (a, b) 1-based single bonds."""
    lines = [name, "     example          3D", "", f"{len(atoms):3d}{len(bonds):3d}  0  0  0  0  0  0  0  0999 V2000"]
    lines += [f"{x:10.4f}{y:10.4f}{z:10.4f} {el:<3} 0  0  0  0  0  0  0  0  0  0  0  0" for el, x, y, z in atoms]
    lines += [f"{a:3d}{b:3d}  1  0" for a, b in bonds]
    return "\n".join(lines) + "\nM  END\n$$$$\n"


WATER_3D = mol_block("water", [("O", 0.0, 0.3664, 0.1), ("H", -0.8123, -0.1835, -0.1), ("H", 0.8131, -0.1829, 0.0)], [(1, 2), (1, 3)])
WATER_FLAT = mol_block("water", [("O", 0.0, 0.0, 0.0)], [])
METHANE_3D = mol_block("methane", [("C", 0.0, 0.0, 0.0), ("H", 0.63, 0.63, 0.63), ("H", -0.63, -0.63, 0.63),
                                   ("H", -0.63, 0.63, -0.63), ("H", 0.63, -0.63, -0.63)], [(1, 2), (1, 3), (1, 4), (1, 5)])


class Workspace(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ws = Path(self.tmp.name).resolve()
        (self.ws / "out").mkdir()
        patcher = mock.patch.object(verdict, "WS", self.ws)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, rel, text, age=0.0):
        path = self.ws / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        stamp = time.time() - age
        os.utime(path, (stamp, stamp))
        return path


class NewestSdf(Workspace):
    def test_the_newest_sdf_wins_and_ensembles_and_dotfiles_never_do(self):
        self.write("out/old.sdf", WATER_3D, age=100)
        new = self.write("out/series/new.sdf", WATER_3D, age=50)
        self.write("out/new.conformers.sdf", WATER_3D, age=0)
        self.write("out/.new.tmp.sdf", WATER_3D, age=0)
        self.assertEqual(newest_sdf(self.ws), new)

    def test_none_without_an_sdf(self):
        self.assertIsNone(newest_sdf(self.ws))


class InspectWithoutRdkit(Workspace):
    def test_without_rdkit_a_file_is_only_counted(self):
        big = self.write("out/big.sdf", WATER_3D)
        small = self.write("out/small.sdf", "x\n")
        with mock.patch.dict(sys.modules, {"rdkit": None}):
            self.assertEqual(inspect(big), {"path": "out/big.sdf", "conformers": 1, "atoms": 0, "error": None})
            self.assertEqual(inspect(small)["conformers"], 0)


@unittest.skipUnless(HAS_RDKIT, "RDKit is not installed for this Python")
class InspectWithRdkit(Workspace):
    def test_a_3d_record_is_one_conformer_with_its_atoms(self):
        self.assertEqual(inspect(self.write("out/water.sdf", WATER_3D)),
                         {"path": "out/water.sdf", "conformers": 1, "atoms": 3, "error": None})

    def test_the_ensemble_beside_it_is_counted(self):
        path = self.write("out/water.sdf", WATER_3D)
        self.write("out/water.conformers.sdf", WATER_3D * 4)
        self.assertEqual(inspect(path)["conformers"], 4)

    def test_an_ensemble_of_another_molecule_is_not_counted(self):
        path = self.write("out/water.sdf", WATER_3D)
        self.write("out/water.conformers.sdf", METHANE_3D * 3)
        self.assertEqual(inspect(path)["conformers"], 1)

    def test_a_flat_record_has_no_conformer_and_no_parse_error(self):
        info = inspect(self.write("out/water.sdf", WATER_FLAT))
        self.assertEqual((info["conformers"], info["atoms"], info["error"]), (0, 1, None))

    def test_a_file_rdkit_cannot_sanitize_is_an_error(self):
        info = inspect(self.write("out/bad.sdf", "not a molecule\n"))
        self.assertEqual(info["error"], "no molecule RDKit could sanitize")

    def test_a_file_rdkit_cannot_open_is_an_error_not_a_crash(self):
        folder = self.ws / "out" / "folder.sdf"
        folder.mkdir()
        info = inspect(folder)
        self.assertEqual(info["conformers"], 0)
        self.assertIn("folder.sdf", info["error"])


class Main(Workspace):
    def run_main(self, argv):
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = verdict.main(argv)
        return code, stdout.getvalue(), json.loads((self.ws / ".harness" / "verdict.json").read_text())

    def test_an_empty_workspace_is_not_ready(self):
        code, out, v = self.run_main(["verdict.py"])
        self.assertEqual(code, 1)
        self.assertEqual(out, "not ready · no design yet\n")
        self.assertEqual(v["summary"], "no design yet")

    def test_a_designed_molecule_is_ready_and_its_findings_are_printed(self):
        self.write("molecules/water.py", "print('water')\n")
        self.write("out/report.json", json.dumps({**REPORT, "name": "water", "atoms": 3, "violations": ["mw 612 > 500"]}))
        self.write("out/water.sdf", WATER_3D)
        code, out, v = self.run_main(["verdict.py"])
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("ready · water · C8H10N4O2"), out)
        self.assertIn("  warning Lipinski: mw 612 > 500\n", out)
        self.assertEqual(v["artifact"], "out/water.sdf")

    def test_a_smi_list_is_a_design_and_a_torn_report_is_no_report(self):
        self.write("molecules/series.smi", "CCO ethanol\n")
        self.write("out/report.json", '{"name": ')
        code, _, v = self.run_main(["verdict.py"])
        self.assertEqual((code, v["summary"]), (1, "no molecule yet"))

    def test_a_named_sdf_is_judged_instead_of_the_newest(self):
        self.write("molecules/water.py", "")
        self.write("out/report.json", json.dumps(REPORT))
        named = self.write("out/named.sdf", WATER_3D, age=100)
        self.write("out/newer.sdf", WATER_3D)
        code, _, v = self.run_main(["verdict.py", str(named)])
        self.assertEqual((code, v["artifact"]), (0, "out/named.sdf"))

    def test_a_series_in_a_subfolder_is_summarised_by_its_own_report(self):
        self.write("molecules/capsaicin.py", "")
        self.write("out/report.json", json.dumps({**REPORT, "name": "ibuprofen"}), age=100)
        self.write("out/ibuprofen.sdf", WATER_3D, age=100)
        self.write("out/capsaicin/report.json", json.dumps({**REPORT, "name": "capsiate"}))
        self.write("out/capsaicin/capsiate.sdf", WATER_3D)
        code, _, v = self.run_main(["verdict.py"])
        self.assertEqual((code, v["artifact"]), (0, "out/capsaicin/capsiate.sdf"))
        self.assertTrue(v["summary"].startswith("capsiate · "), v["summary"])

    def test_a_subfolder_without_its_own_report_falls_back_to_out(self):
        self.write("molecules/water.py", "")
        self.write("out/report.json", json.dumps({**REPORT, "name": "water"}))
        self.write("out/extra/water.sdf", WATER_3D)
        code, _, v = self.run_main(["verdict.py"])
        self.assertEqual((code, v["artifact"]), (0, "out/extra/water.sdf"))
        self.assertTrue(v["summary"].startswith("water · "), v["summary"])

    def test_a_named_sdf_that_is_missing_is_judged_as_none(self):
        self.write("molecules/water.py", "")
        self.write("out/report.json", json.dumps(REPORT))
        code, _, v = self.run_main(["verdict.py", str(self.ws / "out" / "gone.sdf")])
        self.assertEqual((code, v["phases"][1]["state"]), (1, "active"))

    def test_a_named_sdf_outside_the_workspace_is_refused_not_a_crash(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            outside = Path(elsewhere) / "stray.sdf"
            outside.write_text(WATER_3D)
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = verdict.main(["verdict.py", str(outside)])
        self.assertEqual(code, 2)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(stderr.getvalue(), f"not judged · {outside} is outside the workspace ({self.ws})\n")
        self.assertFalse((self.ws / ".harness" / "verdict.json").exists())  # the header keeps what it had

    def test_run_as_a_script_it_judges_harness_workspace(self):
        stdout = io.StringIO()
        with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(self.ws)}), \
                mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(stdout), \
                self.assertRaises(SystemExit) as exit:
            runpy.run_path(verdict.__file__, run_name="__main__")
        self.assertEqual(exit.exception.code, 1)
        self.assertEqual(stdout.getvalue(), "not ready · no design yet\n")
        self.assertTrue((self.ws / ".harness" / "verdict.json").is_file())


if __name__ == "__main__":
    unittest.main()
