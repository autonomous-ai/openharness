"""Native acceptance tests: executed by FreeCADCmd, never mocked geometry."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "skills", "freecad", "scripts"))
import FreeCAD as App
import Part
from geometry import measure, solid


class GeometryTests(unittest.TestCase):
    def check_shape(self, kind, shapes, **fields):
        return measure({"id": "probe", "type": kind, "reason": "Independent native test", **fields}, shapes)["passed"]

    def test_bore_requires_opening_and_material(self):
        plate = Part.makeBox(40, 30, 5)
        hole = Part.makeCylinder(3.2, 7, App.Vector(10, 10, -1))
        shapes = {"Plate": plate.cut(hole)}
        spec = dict(part="Plate", origin=[10, 10, 0], axis=[0, 0, 1], diameter=6.4, length=5, wall=2)
        self.assertTrue(self.check_shape("bore", shapes, **spec))
        for change in [{"origin": [12, 10, 0]}, {"diameter": 7}, {"diameter": 5}, {"origin": [60, 10, 0]}, {"length": 8}]:
            with self.subTest(change=change):
                self.assertFalse(self.check_shape("bore", shapes, **{**spec, **change}))

    def test_containment_is_not_clearance(self):
        shapes = {"Outer": Part.makeBox(20, 20, 20), "Inner": Part.makeBox(2, 2, 2, App.Vector(5, 5, 5))}
        self.assertTrue(self.check_shape("contains", shapes, part="Outer", other="Inner"))
        self.assertFalse(self.check_shape("clearance", shapes, parts=["Outer", "Inner"], minimum=1))
        self.assertFalse(self.check_shape("no-overlap", shapes, parts=["Outer", "Inner"]))
        self.assertFalse(self.check_shape("contains", shapes, part="Inner", other="Outer"))

    def test_measured_gap_and_maximum(self):
        shapes = {"Left": Part.makeBox(10, 10, 10), "Right": Part.makeBox(10, 10, 10, App.Vector(12, 0, 0))}
        self.assertTrue(self.check_shape("clearance", shapes, parts=["Left", "Right"], minimum=2, maximum=2))
        self.assertFalse(self.check_shape("clearance", shapes, parts=["Left", "Right"], minimum=3))
        self.assertFalse(self.check_shape("clearance", shapes, parts=["Left", "Right"], minimum=0, maximum=1))

    def test_bounds_include_position(self):
        shapes = {"Box": Part.makeBox(10, 20, 30, App.Vector(-5, 2, 3))}
        self.assertTrue(self.check_shape("bounds", shapes, part="Box", size=[10, 20, 30], origin=[-5, 2, 3]))
        self.assertFalse(self.check_shape("bounds", shapes, part="Box", size=[10, 20, 30], origin=[0, 0, 0]))
        self.assertFalse(self.check_shape("bounds", shapes, part="Box", size=[11, 20, 30]))

    def test_contacting_parts_are_valid_but_not_fused(self):
        left, right = Part.makeBox(10, 10, 10), Part.makeBox(10, 10, 10, App.Vector(10, 0, 0))
        self.assertEqual(solid(Part.makeCompound([left, right]), "Contact assembly")["solids"], 2)
        self.assertTrue(self.check_shape("no-overlap", {"Left": left, "Right": right}, parts=["Left", "Right"]))

    def test_empty_and_open_shapes_fail(self):
        for shape in [Part.Shape(), Part.makePlane(10, 10)]:
            with self.assertRaises(ValueError):
                solid(shape, "Invalid")


result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(GeometryTests))
if not result.wasSuccessful():
    raise RuntimeError("Native geometry tests failed")
with open(os.environ["FREECAD_TEST_RESULT"], "w") as handle:
    json.dump({"passed": result.testsRun, "freecad": App.Version()[:3]}, handle)
