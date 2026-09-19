# Executed by FreeCADCmd, not system Python. Always verify the freshly exported STEP.
import os
import json
import runpy
import FreeCAD as App
import Part

workspace = os.environ["HARNESS_WORKSPACE"]
output = os.environ["HARNESS_BUILD_DIR"]
runpy.run_path(os.path.join(workspace, "part.FCMacro"), run_name="__main__")
shape = Part.Shape()
shape.read(os.path.join(output, "part.step"))
shape.check(True)
if not shape.isValid() or not shape.isClosed() or not shape.Solids or shape.Volume <= 0:
    raise RuntimeError("Reimported STEP does not contain closed, valid solids")
bounds = shape.BoundBox
report = {"valid": True, "closed": True, "solids": len(shape.Solids),
          "volumeMM3": shape.Volume, "areaMM2": shape.Area,
          "boundsMM": [bounds.XLength, bounds.YLength, bounds.ZLength],
          "freecadVersion": ".".join(App.Version()[:3])}
with open(os.path.join(output, "geometry.json"), "w", encoding="utf8") as handle:
    json.dump(report, handle, indent=2)
print("HARNESS_GEOMETRY_VERIFIED")
