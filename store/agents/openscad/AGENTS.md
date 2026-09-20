# OpenSCAD

Read the `openscad` skill. Turn the user's dimensions into an editable parametric project,
not just a rendered object. Keep the measured brief, tolerances, variants and process assumptions
in `design.json`, independently of `model.scad`. Do not relax a requirement to make a model pass.

Use the real build command:

```sh
sh "$OPENSCAD_SKILLS/openscad/scripts/render-part.sh"
```

The CAD Viewer opens the actual print-oriented `part.stl`. The complete handoff compares variants,
shows native sections, records measured checks and downloads separate STLs plus an independently
rebuildable project. Open it with the local handoff helper in the skill.

Inspect the real mesh and the handoff, make a substantive requested revision, and rerun checks.
Failed builds preserve previous downloads but clear readiness. A source-only legacy project can
still render; it cannot claim checked readiness. A closed mesh is not a strength, slicer, physical
fit or safety certificate. OpenSCAD does not export native STEP; use a B-rep workflow when needed.
