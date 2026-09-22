"""Parameter declarations and persisted choices, without importing Blender."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from harness_design import parameters


class Parameters(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        (self.root / "scenes").mkdir()
        (self.root / "scenes/design.py").write_text("# authored scene\n")
        environment = mock.patch.dict(os.environ, {"HARNESS_WORKSPACE": str(self.root)})
        environment.start()
        self.addCleanup(environment.stop)
        argv = mock.patch.object(sys, "argv", [str(self.root / "scenes/design.py")])
        argv.start()
        self.addCleanup(argv.stop)
        self.controls = {
            "width": {"default": 70, "min": 20, "max": 200, "unit": "mm"},
            "ribs": {"type": "integer", "default": 8, "min": 3, "max": 20},
            "cap": {"type": "boolean", "default": True},
            "finish": {"type": "choice", "default": "Oak", "options": ["Oak", "Ash"]},
        }

    def choose(self, values):
        (self.root / "design-values.json").write_text(json.dumps({"spec": 1, "values": values}))

    def test_publishes_source_controls_and_reads_partial_values(self):
        (self.root / "assets").mkdir()
        self.choose({"width": 125, "cap": False, "finish": "Ash"})
        self.assertEqual(parameters(self.controls, title="My lamp"), {"width": 125, "ribs": 8, "cap": False, "finish": "Ash"})
        path = self.root / ".harness/design.json"
        definition = json.loads(path.read_text())
        self.assertEqual(definition["sources"], ["scenes", "assets"])
        self.assertEqual(definition["entry"], "scenes/design.py")
        self.assertEqual(definition["controls"][0]["default"], 70)
        stamp = path.stat().st_mtime_ns
        parameters(self.controls, title="My lamp")
        self.assertEqual(path.stat().st_mtime_ns, stamp, "unchanged declarations must not trigger rebuild loops")

    def test_rejects_invalid_chosen_values_before_publishing(self):
        for values in ({"width": True}, {"width": 201}, {"width": float("nan")}, {"ribs": 2.5},
                       {"finish": "Maple"}, {"cap": 1}, {"unknown": 3}):
            with self.subTest(values=values):
                self.choose(values)
                with self.assertRaises(ValueError):
                    parameters(self.controls)
                self.assertFalse((self.root / ".harness/design.json").exists())

    def test_source_and_output_paths_have_one_portable_contract(self):
        for source in (".", "scenes/../scenes", "/tmp", "scenes//", ".env", "out", "node_modules", "_harness_tools"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                parameters(self.controls, sources=["scenes", source])
        for output in ("out/designs/a.glb", "model.glb", "out/.private.glb", "out/model.GLB"):
            with self.subTest(output=output), self.assertRaises(ValueError):
                parameters(self.controls, output=output)
        with self.assertRaises(ValueError):
            parameters(self.controls, sources=["assets"])

    def test_bad_defaults_and_ranges_do_not_become_controls(self):
        for control in ({"default": 3, "min": 5, "max": 10}, {"default": 6, "min": 5, "max": 10, "step": 0},
                        {"default": True, "min": 0, "max": 10}, {"type": "choice", "default": "a", "options": ["a", "a"]},
                        {"type": "integer", "default": 2, "min": 1.5, "max": 10}):
            with self.subTest(control=control), self.assertRaises(ValueError):
                parameters({"value": control})


if __name__ == "__main__":
    unittest.main()
