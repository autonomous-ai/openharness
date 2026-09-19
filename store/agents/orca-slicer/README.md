# Orca Slicer · Strata

Turn a mesh into a toolpath you can actually inspect. Strata shows the real linear
moves from OrcaSlicer: scrub 240 layers of the included fluted vessel, orbit the
stack, isolate a layer, show travel and purge paths, or color by speed.

## First run

Install `autonomous/orca-slicer` from the Harness Store. Install
[OrcaSlicer 2.4.2](https://github.com/OrcaSlicer/OrcaSlicer/releases) separately,
then run the harness doctor. Set `ORCA_BIN` for a nonstandard binary.
The included model and **demo** profiles make a local toolpath study:

```sh
sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"
```

The build produces `part.gcode`, `preview.html`, and a fresh verdict. The default
Prusa MK3S / 0.4 mm / PLA profile is **not your printer**. Do not send this G-code
to hardware until you have reviewed the exact machine, filament, temperatures,
bed origin, first layer and all machine-specific commands in OrcaSlicer.

## Make it yours

Ask: “Adapt this dry-use vessel to 70 mm tall, compare two layer heights, and
explain the time/filament tradeoff. Do not print it.”

Edit `slice-config.json`, not the descriptive `print-config.md`. Demo profile
paths resolve against the installed Orca profiles directory; on Linux or a
nonstandard install set `ORCA_PROFILES_DIR`. Custom mode takes three exported JSON
profiles, relative to the workspace or absolute. Put inherited parent JSON files
beside their children; the builder resolves the explicit chain and records the
flattened settings in `.harness/*-resolved.json`. Missing parents fail rather
than silently substituting defaults. The model must be an STL inside the workspace.

The original `model.scad` is included alongside its generated STL. Edit it with
OpenSCAD, re-export the mesh, then re-slice. This harness does not run a CAD build
automatically.

## What is verified

A new OrcaSlicer process must succeed and produce exactly one fresh, nonempty
G-code plate with linear extrusion paths. Failed builds clear readiness and
preserve the previous preview. Logs and receipts live in `.harness/`.
The starter was sliced with OrcaSlicer 2.4.2 and inspected in a real browser.
Unit tests additionally cover parsing, profile inheritance and failed builds.

The inspector supports single-tool linear G0/G1 paths, coordinate/extrusion
modes, resets and units. Arc fitting and post-processing are disabled for this
workflow. Curved/multitool paths fail explicitly. Travel-only Z-hop heights are
omitted from the layer list. Custom/purge moves are hidden in model focus by
default; enable them to inspect the full extent. Estimates come from the slicer,
not a timed print. No mesh-manifold, collision, thermal, firmware or structural
safety certification is implied. Nothing is uploaded, printed or connected.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
