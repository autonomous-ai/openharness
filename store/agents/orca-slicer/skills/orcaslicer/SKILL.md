---
name: orcaslicer
description: Turn a user's STL and explicit machine/material requirements into compared OrcaSlicer plans, editable 3MF projects, checked G-code and a portable handoff. Use for Orca Slicer harness work.
---

# Strata: mesh to an owned slicing project

## Establish the brief

Ask for a mesh, its intended millimetre dimensions and use, and the actual
printer model, nozzle, firmware, plate and filament. Ask which tradeoff matters.
If those details are unavailable, a clearly labelled software-only example is
useful; keep `machine.context: "example"`. No hardware is needed to compare,
inspect, revise or export it. Do not treat the example as the user's printer.

Start from the schema in `template/slice-config.json` in this package. Save the
brief before running the slicer:

- `sourceFiles` is the explicit portable-source allowlist. Include the config,
  STL, supporting CAD/notes and all workspace-profile inheritance files.
  Never add unrelated workspace files or credentials.
- `model.expectedSizeMM` is the requirement, not a value copied back from a
  failed output. STL has no unit metadata. `rotationDegrees` rotates X, then Y,
  then Z; `scale` is explicit. Orca cannot silently reorient this workflow.
- `profiles.source` is `installed` or `workspace`. Installed paths are relative
  to `ORCA_PROFILES_DIR` or Orca's bundled profiles directory. Workspace paths
  are safe relative paths, with inherited JSON parents beside the child.
  Remove connection credentials and post-processors from exported profiles.
- `machine` records independent model/nozzle/bed/plate/firmware/material and
  temperature envelopes. These bounds apply to all nonzero heater commands,
  including startup targets; they are not measured temperatures.
- Save 1–4 `plans`, a `selectedPlan`, estimate budgets and a bed inset. Each plan
  states layer/first-layer heights, walls, infill, top/bottom layers, supports
  and brim. Changing a prose note does not change a slicing setting.

The current checked scope is one closed STL, one extruder, Marlin or Marlin 2,
and a zero-origin rectangular bed without exclusion zones. Unknown fields,
unsupported motion/macros and missing profiles fail explicitly. Do not broaden
a passing claim to Klipper macros, multi-material, belt/nonrectangular machines
or firmware retraction. Unsupported machines need a separately implemented
and verified workflow, not an arbitrary flag change.

## Build, inspect, revise

```sh
sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"
```

Node 22+ and OrcaSlicer 2.4.2 are tested. Set `ORCA_BIN` and, where needed,
`ORCA_PROFILES_DIR`. This helper does not use PrusaSlicer's different CLI.
It creates an isolated Orca data directory and fresh output per plan; no printer
connection is made. Arc fitting, post-processing, spiral mode and infill
combination are disabled. Top/bottom thickness minima are zero so the saved
layer counts are not silently overridden by inherited minimum-thickness values.

Open `preview.html` in the harness. Compare estimates, inspect the first layer,
isolate layers, show travel and use **Full motion** to include purge, Z hops and
final parking. The normal layer list includes extrusion heights, not every
travel height. Custom purge may legitimately lie outside the model inset;
review its separately reported full-motion bounds and exact commands.

Use `handoff/report.json` for the saved source revision, profile names, effective
settings, checks, temperatures and native-reopen evidence. The live verdict is
`.harness/verdict.json`; a retained preview after a failure is an older success.
`.harness/slice.log` contains native diagnostics. Never hand-edit checks or
readiness to suppress a failure.

Make revisions in the saved inputs, then rebuild. Check that the requested
change appears in effective settings and actual paths/estimates. Discuss the
tradeoff without promising strength, finish or physical fit from wall counts.
The included `model.scad` is provenance, not an automatically compiled input:
after CAD changes, re-export its STL before slicing.

## Deliver a reusable result

Each `handoff/plans/<id>/` contains actual G-code, native editable `project.3mf`,
effective JSON and an inspection receipt. `part.gcode` and `part.3mf` are the
selected plan. The complete-project ZIP includes declared source, flattened
profiles, all native results and standalone Node helpers. It excludes unrelated
files and the Orca binary. Respect upstream profile notices.

Reopen the chosen 3MF in OrcaSlicer. For a handoff verification, extract the ZIP
into a separate directory and run `node rebuild/build.mjs` with `ORCA_BIN` set.
Use `node rebuild/serve-preview.mjs .` for its loopback viewer; file:// cannot
fetch toolpaths. Downloaded review JSON saves plan/view/notes and restores only
against the matching source and G-code hashes. It is not print authorization.

## What the checks establish

The helper measures mesh closure/orientation, dimensions and bed envelope;
checks effective settings against emitted G-code settings and saved constraints;
inspects linear model/support centerlines, layer heights, estimate budgets and
actual heater target commands; requires both heaters off after final extrusion;
and verifies exact embedded G-code plus native 3MF geometry/settings reopening.
The only reopen normalization is absent versus empty `upward_compatible_machine`
preset metadata. No slicing value is ignored.

Limits: 32 MiB per source/G-code/download, 64 MiB total declared sources,
1,000,000 linear moves, 1,000,000 STL triangles, 4 plans, 128 MiB expanded ZIP.
Mesh checks weld at 1e-5 mm; they do not prove no self-intersections. The parser
models retraction debt, units and coordinate/extrusion modes, but not actual
firmware motion, offsets, leveling, pressure/flow overrides, collisions, thermal
behavior, support adequacy or material mechanics. Estimates are not timed prints.
No physical print or safety certification is implied. Never upload or print
without a separate explicit request and the appropriate machine-specific review.
