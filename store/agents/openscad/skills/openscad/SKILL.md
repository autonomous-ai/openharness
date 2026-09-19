---
name: openscad
description: Create parametric OpenSCAD models, export and inspect fresh meshes, and iterate in the shared CAD Viewer.
---

# OpenSCAD

Use named millimetre dimensions at the top of `model.scad`, assertions for invalid combinations,
and small reusable modules. Preserve the user's target machine/material/fit constraints.
The Ripple starter's height, diameter, wall, ribs and twist are editable; it is not a required style.

```sh
sh "$OPENSCAD_SKILLS/openscad/scripts/render-part.sh"
```

Requires Node 20+ and OpenSCAD. The helper resolves `OPENSCAD_BIN`, the toolchain link, PATH or the
standard macOS app. It runs one real export into a unique staging directory, writes the compiler
output to `.harness/build.log`, inspects the STL, then replaces `part.stl` only on success.
`.harness/mesh.json` reports triangles, volume, area, bounds, degenerate faces and open/non-manifold
edges. Failure always clears the verdict's readiness and artifact rather than endorsing an old mesh.

The STL check welds coordinates to five decimal places and checks paired, oppositely directed edges.
It does not detect all self-intersections or certify wall thickness, printability, strength or fit.
Review overhangs, intended orientation, supports, clearances and process-specific wall requirements.
Don't describe a closed mesh as proof of manufacturing safety.

For manual variants: `openscad -o tall.stl -D height=100 model.scad`. Export 2D contours with
`openscad -o outline.dxf drawing.scad`. OpenSCAD does not natively export STEP; request/choose a
true CAD workflow for B-rep editing or machining rather than relabeling a mesh.

Inspect the actual STL in the CAD Viewer: orbit, fit, section and measure as appropriate.
A source-code screenshot or a successful exit code is not visual verification.
