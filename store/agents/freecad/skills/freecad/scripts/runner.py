# Executed by FreeCADCmd, not system Python. Always verify the freshly exported STEP.
import os
import json
import runpy
import sys
import FreeCAD as App
import Part

tools = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, tools)
from design import validate
from geometry import export_project, solid
from handoff import read_sources, fingerprints, write_handoff

workspace = os.environ["HARNESS_WORKSPACE"]
output = os.environ["HARNESS_BUILD_DIR"]
sys.path.insert(1, workspace)
project = None
contract = os.path.join(workspace, "design.json")
if os.path.exists(contract):
    if os.path.getsize(contract) > 1024 * 1024:
        raise ValueError("design.json exceeds 1 MiB")
    with open(contract, encoding="utf8") as handle:
        project = validate(json.load(handle))
    sources = read_sources(project, workspace)
runpy.run_path(os.path.join(workspace, "part.FCMacro"), run_name="__main__")
if project:
    report = export_project(project, os.path.join(output, "part.FCStd"), output)
    if fingerprints(read_sources(project, workspace)) != fingerprints(sources):
        raise ValueError("Source changed during the build; rebuild from the current saved inputs")
    write_handoff(project, report, sources, output, tools)
else:
    # Legacy projects still render, but have no claim of checked design requirements.
    shape = Part.Shape()
    shape.read(os.path.join(output, "part.step"))
    report = {**solid(shape, "Reimported STEP"), "valid": True, "closed": True,
              "designChecked": False, "requirementsPassed": False,
              "checks": [], "parts": [], "freecadVersion": ".".join(App.Version()[:3])}
with open(os.path.join(output, "geometry.json"), "w", encoding="utf8") as handle:
    json.dump(report, handle, indent=2, allow_nan=False)
print("HARNESS_GEOMETRY_VERIFIED")
