# OpenSCAD

Read the `openscad` skill. Build parametric geometry in `model.scad` and render it with
`sh "$OPENSCAD_SKILLS/openscad/scripts/render-part.sh"`. The shared CAD Viewer opens `part.stl`.

Keep dimensions, units, tolerances and manufacturing assumptions visible. The Ripple starter is
an editable dry-use vessel, not a certified printable, watertight or food-safe product.
Render early, inspect the actual part, then iterate.

The helper stages a fresh STL, checks triangle topology, volume and bounds, and updates the verdict.
It cannot certify wall thickness, material strength, overhangs or fit. Do not claim those checks ran
when they did not. A failed build preserves the previous export but clears readiness.

OpenSCAD has no native STEP export. Do not run `openscad -o part.step` or promise a true B-rep from
that command. For editable STEP geometry, use an appropriate CAD workflow such as FreeCAD.
