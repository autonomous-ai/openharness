# OpenSCAD

Turn “this needs to fit my drawer” into an editable family of parts. Describe the object, provide
measurements, compare size or clearance variants, and take the checked STLs to your own slicer.

The **Drawer Grid** starter creates three organizer widths with the same floor, walls and pocket
requirements. A second tested workflow builds a six-bottle craft rack and matching fit-test rings:
try a small ring before spending material on the full rack.

Try: “My drawer has 205 × 110 × 45 mm clear space. Make a four-compartment organizer with clearance
around the outside. Show two size options and keep the floor 2.4 mm thick.”

## What you take away

- Editable `model.scad` and a saved `design.json` brief, parameter limits, variants and checks.
- Separate, print-oriented STLs; native top/front/side inspection views; measured evidence.
- A comparison/download page and a complete ZIP that rebuilds with Node + OpenSCAD outside Harness.
- A preserved last-good handoff if the next revision fails.

Checks run on the actual exported mesh: closed-edge topology, positive oriented volume, surface
shells, specified dimensions, clearance regions, required material and relative-part interference.
Each final STL is reopened in OpenSCAD and checked against the declared individual printer envelope.
A successful export does **not** certify physical fit, strength, global wall thickness, supports,
slicing or food safety. No physical print is claimed.

## Run it

Install OpenSCAD and Node 20+; the shared CAD Viewer is a separate dependency. Native QA used
OpenSCAD 2021.01. Set `OPENSCAD_BIN` if it is not on PATH or at the standard macOS app location.

```sh
harness dsh install "$PWD/store/agents/openscad" --link
harness dsh doctor autonomous/openscad
```

Inside a workspace, ask the agent to build the saved brief. The main pane shows the selected actual
STL. The local handoff helper opens variant comparison and downloads; its page describes the last
successful build, not unbuilt source edits. Extract the project ZIP and run
`node rebuild/build.mjs .` to regenerate it with no Harness account or npm install.

The old Ripple source remains in `test/fixtures/ripple.scad`. Existing SCAD-only workspaces still
render, with readiness false until a checked brief is added. OpenSCAD has no native STEP export.

See [the schema](skills/openscad/references/design.md) and [acceptance evidence](test/ACCEPTANCE.md).

## Credit and stewardship

The original wrapper, source examples and delivery tools are MIT-licensed OpenHarness work.
[OpenSCAD](https://openscad.org) is separately installed; the shared CAD Viewer carries its own
upstream notices. See [PROVENANCE.md](PROVENANCE.md). No upstream ownership or endorsement is implied.
Wrapper issues belong in OpenHarness; upstream maintainers are welcome to take stewardship.
