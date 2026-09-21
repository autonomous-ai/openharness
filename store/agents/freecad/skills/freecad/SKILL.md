---
name: freecad
description: Turn measured design briefs or existing parts into editable FreeCAD projects with checked dimensions, bores, clearances, interference and fastener access; deliver separate STEP/STL parts, reference drawings and a portable project handoff.
---

# FreeCAD

## From brief to useful part

Establish what the part must fit, how it attaches, which dimensions are measured, the units and
the intended process/material. Explain a needed measurement in everyday terms. A sketch or photo
can guide shape, but does not establish scale or hidden dimensions. Record assumptions separately
from requirements. For load-bearing, electrical, medical or other consequential uses, identify
the necessary professional/physical validation; do not certify suitability from a CAD preview.

Create `design.json` with the brief, named parts/reference envelopes and measurable checks. Read
[the design contract](references/design-contract.md) when creating or changing this file. Cover
the requirements that matter to the user's job: outside dimensions alone do not establish fit.
Use reference shapes for boards, connectors, movement or fastener/tool access, and check those
references' dimensions/positions so an accidentally moved or undersized keep-out cannot pass.

Build the appropriate model, not automatically an enclosure. `part.FCMacro` is Python executed by
FreeCADCmd, not system Python. Use `FreeCAD as App`, `Part`, named inputs and reusable construction
functions. Import an existing STEP as a reference when useful; include only user-approved input
files in the explicit `sourceFiles` list. Never bundle an entire workspace or hidden credentials.

The macro reads inputs from `HARNESS_WORKSPACE`, creates the named document objects and saves
`part.FCStd` in the unique `HARNESS_BUILD_DIR`. Close the document after saving. The runner handles
exports, measurements, drawings and the portable bundle. The example's `dimensions.json` is an
editable starting point, not a restriction on new designs. Preserve a user's existing work.

## Build and inspect

```sh
sh "$FREECAD_SKILLS/freecad/scripts/build-part.sh"
```

Requires Node 20+ and headless FreeCAD with Part, MeshPart and TechDraw (tested with 1.1.3).
The wrapper resolves `FREECAD_BIN`, the toolchain link,
`freecadcmd`/`FreeCADCmd` or the installed macOS app. Recent macOS packages put the CLI at
`FreeCAD.app/Contents/Resources/bin/freecadcmd`, not necessarily `Contents/MacOS/FreeCADCmd`.

The runner reopens the native document and validates its individual solids. Each manufactured part
must be one solid; declare disconnected pieces separately. It checks the saved requirements and
reimports individual STEP and STL exports. STEP volume, size and position must survive export;
STL must be a closed mesh with matching dimensions. Assembly contacts are allowed, but unwanted
overlap must be covered by interference/clearance checks. Reference objects are not exported.

Read `.harness/geometry.json`, inspect the actual assembly in the shared CAD Viewer and review
each projected drawing. Inspect access, orientation and assembly sequence as well as dimensions.
For revisions, retain unchanged requirements; update requirements only when the brief changes.
Rebuild, inspect the changed geometry and report what changed. Never treat a previous render as
evidence of a successful new build.

On failure, inspect `.harness/build.log` or `.harness/failed-design.json`. A failed measured candidate
is shown as `candidate.step`; the last successful `part.step` and `handoff/` stay unchanged. Fix the
model or resolve the brief conflict, not the test threshold. `.harness/history/` retains replaced
successful artifacts. Do not delete history or a build lock merely to hide an error. A stale lock
may be removed only after confirming its owning build is no longer running.

Legacy macros without `design.json` may still export `part.step`, but remain `ready:false`: geometry
validity alone is not a checked job. Add requirements before claiming a complete handoff.

## Deliver and keep editing

After a successful build, explain the measured results and unresolved manufacturing assumptions.
Deliver `handoff/project.zip` plus the human-readable `handoff/index.html`, not just a screenshot.
To give the user a clickable local download page, run this in a managed long-lived process and
share the printed loopback URL (keep it running while the user needs it; Ctrl-C stops it):

```sh
node "$FREECAD_SKILLS/freecad/scripts/serve-handoff.mjs" "$HARNESS_WORKSPACE"
```

The server serves only generated handoff artifacts, never directory listings or arbitrary inputs.
The page is a receipt of the last successful build, not a live claim about later edits.

The ZIP contains the explicitly selected sources, native document, assembly, separate parts,
dimensioned reference SVGs, measurement receipt and standalone tools. With Node and FreeCAD
installed, extract it elsewhere and run `node tools/build.mjs`; no Harness installation is needed.
Verify this path for a materially new workflow before presenting it as independently reproducible.

STEP files keep assembly coordinates. Each part STL is translated to nonnegative coordinates,
without choosing a print orientation. Quantity is a bill-of-parts count, not repeated geometry.
The assembly STL is not a prepared print layout. The SVGs show overall projected dimensions;
they are not fully toleranced production drawings. Review material, wall thickness, tool access,
supports and physical fit separately. The macro is executable Python; run only trusted sources.
Native files may contain generated Part features, not a fully constrained Sketcher history.
