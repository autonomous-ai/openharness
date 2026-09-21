# Orca Slicer · Strata

Turn “I have this STL—how should I print it?” into a project you can inspect,
change and take to OrcaSlicer. Compare real slicing plans for time, material and
layer tradeoffs; inspect actual toolpaths and heater commands; keep the editable
native 3MF, G-code, profiles and source together.

No printer is required to use the software workflow. The starter is a six-bottle
craft rack, sliced three ways against an explicitly labelled example machine.
It is not a recommendation for an unknown printer.

## Try it

Install `autonomous/orca-slicer` from the Harness Store and install
[OrcaSlicer 2.4.2](https://github.com/OrcaSlicer/OrcaSlicer/releases) separately.
The harness uses its managed Node runtime. For a nonstandard installation set
`ORCA_BIN`; for profiles outside the usual app resources set `ORCA_PROFILES_DIR`.

Ask: “Compare faster and finer plans for this rack. Keep the printer as a
software-only example. Show the actual tradeoff and give me projects I can edit.”

```sh
sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"
```

The viewer compares plans, verifies each G-code hash before display, scrubs or
isolates layers, colors by feature/speed, and shows every commanded linear move
in **Full motion**, including purge, Z hops and parking. Review notes and view
state can be downloaded and restored for that exact source/toolpath revision.

## Use your own part

Supply an STL and its millimetre dimensions, intended use, printer/nozzle,
firmware, plate and filament. Save requirements in `slice-config.json` before
slicing. Use installed profiles or explicit workspace JSON exports and their
sibling inheritance files. Profile credentials and post-processors are rejected.

Compare 1–4 plans; choose heights, wall counts, infill, top/bottom layers,
supports and brim, with saved time/material estimate budgets and a bed inset.
Orientation and scale are explicit; no silent auto-orient. The current checked
scope is one closed STL, one extruder, Marlin/Marlin 2, and a zero-origin
rectangular bed without exclusion zones. Unsupported workflows fail clearly.

Revise the brief or mesh, then rebuild. CAD source is included for editing, but
this slicer uses the STL; it does not automatically compile SCAD changes.

## Own the result

- `part.gcode` / `part.3mf`: the selected plan.
- `handoff/plans/<id>/`: every actual G-code, editable native 3MF, effective
  settings and inspection receipt.
- `handoff/report.json`: source hashes, requirements, comparisons and evidence.
- `handoff/project.zip`: declared source, flattened profiles, results and
  standalone rebuild/preview tools. No binary or unrelated workspace files.
- `.harness/verdict.json`: current build status. Failed candidates preserve the
  last good handoff and clear readiness; earlier outputs are in local history.

Extract the ZIP elsewhere, install Node 22+ and OrcaSlicer, then:

```sh
ORCA_BIN=/path/to/OrcaSlicer node rebuild/build.mjs
node rebuild/serve-preview.mjs .
```

Open the printed loopback URL. Native 3MF/G-code work independently of the viewer.

## Evidence, not a print certificate

Every plan is freshly sliced. The builder checks independent saved dimensions,
closed positive-volume mesh shells, profile/setting agreement, actual heater
commands, model/support centerlines, layers and estimate budgets. It verifies
the exact G-code inside the 3MF, then reopens the project in Orca and compares
geometry and effective settings. See [acceptance evidence](test/ACCEPTANCE.md).

`ready` means those software checks passed—not that a physical print was tested.
No strength, fit, support adequacy, collision, firmware, thermal or food-safety
claim is made. Purge/parking can extend beyond the model inset and must be
reviewed. The inspector is bounded to 32 MiB G-code / one million linear moves.
Review the actual printer, profiles, plate, material, custom commands and first
layer in OrcaSlicer before any hardware use. Nothing is uploaded or printed.

## Credit and stewardship

Original OpenHarness wrapper/UI/models are MIT. OrcaSlicer and selected upstream
profiles retain their separate terms; see [PROVENANCE.md](PROVENANCE.md).
No upstream ownership or endorsement is implied.
Wrapper issues belong in OpenHarness; upstream maintainers are welcome to take
stewardship of the package.
