import contextlib, io, json, os, runpy, sys, tempfile, time, unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import judge

HERE = Path(__file__).resolve().parent
BIG = b"x" * 600          # over the 500 bytes that make a file count


class Judge(unittest.TestCase):
    def test_modelled_exported_rendered(self):
        v = judge(True, {"objects": ["Mug", "Handle"], "faces": 12400, "size_mm": [90, 90, 100]}, True, True, True)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "2 objects · 12,400 faces · 90×90×100 mm · glb"); self.assertEqual(v["artifact"], "out/model.glb")
    def test_empty_scene_fails_model(self):
        v = judge(True, {"objects": [], "faces": 0}, False, False, False)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][0]["state"], "failed")
        self.assertEqual(v["findings"], [{"severity": "error", "kind": "model", "message": "the scene has no geometry"}])
    def test_preview_only(self):
        v = judge(True, {"objects": ["a"], "faces": 12, "size_mm": [1, 1, 1]}, False, True, False)
        self.assertTrue(v["ready"]); self.assertIsNone(v["artifact"]); self.assertEqual(v["phases"][1]["state"], "active")

    def test_artifact_is_the_named_export_never_the_video(self):
        v = judge(True, {"objects": ["a"], "faces": 12, "size_mm": [1, 1, 1]}, True, True, True, "out/lamp.glb")
        self.assertEqual(v["artifact"], "out/lamp.glb")
    def test_modelled_without_export_warns(self):
        v = judge(True, {"objects": ["a"], "faces": 12, "size_mm": [1, 1, 1]}, False, True, True)
        self.assertIsNone(v["artifact"]); self.assertEqual([f["kind"] for f in v["findings"]], ["export"])
    def test_a_heavy_mesh_warns_and_a_report_without_size_says_none(self):
        v = judge(True, {"objects": ["a"], "faces": 2_500_000}, True, False, True)
        self.assertTrue(v["ready"])
        self.assertEqual([(f["severity"], f["kind"]) for f in v["findings"]], [("warning", "model")])
        self.assertEqual(v["summary"], "1 object · 2,500,000 faces · glb")
    def test_nothing_yet(self):
        v = judge(False, None, False, False, False)
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual((v["summary"], v["findings"], v["ready"]), ("no model yet", [], False))
    def test_a_script_that_has_not_run(self):
        v = judge(True, None, False, False, False)
        self.assertEqual(v["phases"][0]["state"], "active")


class Artifact(unittest.TestCase):
    def test_report_then_model_then_newest(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(verdict, "WS", Path(d)):
            ws = Path(d); (ws / "out").mkdir()
            ok = lambda p: bool(p) and (ws / p).is_file() and (ws / p).stat().st_size > 500
            self.assertIsNone(verdict.glb_path(None, ok))
            (ws / "out/a.glb").write_bytes(BIG); time.sleep(0.02); (ws / "out/b.glb").write_bytes(BIG)
            self.assertEqual(verdict.glb_path(None, ok), "out/b.glb")
            (ws / "out/model.glb").write_bytes(BIG)
            self.assertEqual(verdict.glb_path(None, ok), "out/model.glb")
            self.assertEqual(verdict.glb_path({"files": {"glb": "out/a.glb"}}, ok), "out/a.glb")
            self.assertEqual(verdict.glb_path({"files": {"glb": "out/gone.glb"}}, ok), "out/model.glb", "a named export that is not there")

    def test_partial_tiny_and_other_files_are_never_the_export(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(verdict, "WS", Path(d)):
            ws = Path(d); (ws / "out" / "parts").mkdir(parents=True)
            ok = lambda p: bool(p) and (ws / p).is_file() and (ws / p).stat().st_size > 500
            (ws / "out/parts/lid.gltf").write_bytes(BIG); time.sleep(0.02)
            (ws / "out/.lid.partial.glb").write_bytes(BIG)       # an export being written
            (ws / "out/stub.glb").write_bytes(b"x")              # not a model yet
            (ws / "out/turntable.mp4").write_bytes(BIG)
            self.assertEqual(verdict.glb_path({"files": {"glb": 7}}, ok), "out/parts/lid.gltf")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(verdict, "WS", Path(d)):
            self.assertIsNone(verdict.glb_path(None, lambda p: p != "out/model.glb"), "no out/ folder to search")


class Main(unittest.TestCase):
    """verdict.py on a workspace: what it reads, what it writes, what it prints and returns."""

    def run_in(self, files: dict) -> tuple[int, str, dict]:
        with tempfile.TemporaryDirectory() as d, mock.patch.object(verdict, "WS", Path(d)):
            ws = Path(d)
            for rel, body in files.items():
                path = ws / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode())
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                code = verdict.main(["verdict.py"])
            return code, printed.getvalue(), json.loads((ws / ".harness" / "verdict.json").read_text())

    def test_a_modelled_exported_rendered_workspace(self):
        code, printed, v = self.run_in({
            "scenes/lamp.py": "", "out/report.json": {"objects": ["Lamp"], "faces": 800, "size_mm": [120, 120, 300], "files": {"glb": "out/lamp.glb"}},
            "out/lamp.glb": BIG, "out/preview.png": BIG, "out/turntable.mp4": BIG})
        self.assertEqual(code, 0)
        self.assertEqual((v["artifact"], v["summary"]), ("out/lamp.glb", "1 object · 800 faces · 120×120×300 mm · glb"))
        self.assertEqual(printed, "ready · 1 object · 800 faces · 120×120×300 mm · glb\n")

    def test_a_render_that_is_too_small_is_not_a_render(self):
        code, printed, v = self.run_in({"scenes/a.py": "", "out/report.json": {"objects": ["a"], "faces": 6}, "out/preview.png": b"x"})
        self.assertEqual(code, 1)
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "active"])
        self.assertIn("  warning no glTF export", printed)

    def test_a_scene_without_geometry_prints_its_error(self):
        code, printed, v = self.run_in({"scenes/a.py": "", "out/report.json": {"objects": [], "faces": 0}})
        self.assertEqual(code, 1)
        self.assertEqual(printed.splitlines(), ["not ready · no model yet", "  error   the scene has no geometry"])

    def test_a_half_written_or_foreign_report_is_no_report(self):
        for body in ("{\"objects\": [", "[1, 2]", "\"done\"", "null"):
            with self.subTest(report=body):
                code, _, v = self.run_in({"scenes/a.py": "", "out/report.json": body, "out/model.glb": BIG})
                self.assertEqual(code, 1)
                self.assertEqual((v["summary"], v["findings"]), ("no model yet", []))
                self.assertEqual(v["artifact"], "out/model.glb", "the last export still shows")

    def test_an_empty_workspace(self):
        code, _, v = self.run_in({})
        self.assertEqual((code, v["summary"], v["phases"][0]["state"]), (1, "no model yet", "active"))

    def test_run_as_a_script(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "scenes").mkdir()
            (Path(d) / "scenes" / "a.py").write_text("")
            with mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": d}), mock.patch.object(sys, "argv", ["verdict.py"]), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_:
                    runpy.run_path(str(HERE / "verdict.py"), run_name="__main__")
            self.assertEqual(exit_.exception.code, 1)
            self.assertEqual(json.loads((Path(d) / ".harness" / "verdict.json").read_text())["summary"], "no model yet")


if __name__ == "__main__": unittest.main()
