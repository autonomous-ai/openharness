---
name: openscad
description: Turn measured requirements into editable OpenSCAD part families, compare fit variants, and deliver checked STLs plus a portable project.
---

# OpenSCAD

Build a useful object from the user's real measurements and intended process. The starter is a
drawer-organizer family, not a prescribed shape. For multi-part mechanisms requiring a true
B-rep/STEP deliverable, choose a suitable CAD workflow instead of relabeling an STL.

Before authoring a checked project, read [references/design.md](references/design.md) for the source
interface, requirement schema and probe semantics. Keep the brief and limits in `design.json`;
implement `module part(id, …named parameters…)` in `model.scad`. The builder calls each part with the
saved variant values; it ignores top-level preview geometry. Declared input files are the only
sources copied into the portable project. Compile trusted SCAD only; this is not a sandbox.

Ask for missing measurements that would change the result. Otherwise state assumptions and make
progress. For a mating fit, useful variants often differ only in clearance; a small fit coupon
can save a full print. Never call a generated coupon a completed physical test.

```sh
sh "$OPENSCAD_SKILLS/openscad/scripts/render-part.sh"
node "$OPENSCAD_SKILLS/openscad/scripts/serve-handoff.mjs" "$HARNESS_WORKSPACE"
```

Requires Node 20+ and a separately installed OpenSCAD (tested 2021.01); set `OPENSCAD_BIN` for a custom
location. The second command prints a loopback-only URL. Open that URL for variant comparison,
native top/front/side sections, individual print-oriented STLs, the measured report and
`handoff/project.zip`. It remains a saved snapshot after edits; rebuild before relying on it.
The main CAD pane displays the selected `design.preview` part as `part.stl`.

The helper renders every variant and part, checks repeat exports agree, then measures the actual
saved mesh: closure/orientation/surface-shell count, required bounds/volume, empty clearance
regions, required material and optional relative-part overlap. It orients individual STLs,
moves them onto the bed, checks the declared build envelope and natively reimports them.
Section planes are explicit; silhouettes are labelled. Outputs publish only after all checks
and source-hash checks pass. A build lock prevents competing writers; previous outputs live in
`.harness/history/`. Inspect `.harness/build.log` and `.harness/failed-mesh.json` after a failure.
Do not remove a lock until its owner process has stopped.

Inspect the actual STL in the CAD Viewer (orbit, section/measure when useful), not a source-code
screenshot. Review the handoff on the intended screen size and make a substantive revision.
Keep the user's requirements fixed while correcting geometry. Test that a known obstruction or
missing material is rejected; do not weaken checks to obtain a green verdict.

The ZIP includes source, variant wrappers, all exported parts/views and standalone rebuild tools.
Extract it and run `node rebuild/build.mjs .` with Node and OpenSCAD installed; no Harness account
or npm packages are required. `preview.scad` opens the selected editable configuration in OpenSCAD;
`handoff/source-previews/` contains the other configurations. These preserve design coordinates;
downloadable STLs use print coordinates.

Checks cover only declared probe regions, not global minimum thickness or every self-intersection.
They do not certify strength, slicing/supports, packed-plate capacity, food safety or real fit.
Separate the digital evidence, process assumptions and physical testing still needed.
A legacy `model.scad` without `design.json` renders a geometry preview with readiness false.
