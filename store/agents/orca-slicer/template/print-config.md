# Saved slicing brief

slice-config.json is executable; these notes explain the example.

- Goal: compare the same six-pocket rack across three actual native slicing plans.
- Requirements: source mesh 87.8 × 59.2 × 18 mm, explicitly millimetres.
- Machine/material: example Prusa MK3S / one 0.4 mm nozzle / PLA / High Temp Plate.
  This is not a claim about the user's printer. No printer is connected.
- Each plan must stay within the saved 8-hour / 80 g estimate budgets and the
  5 mm model/support-centerline bed inset. Custom purge and parking are reported
  separately and must be reviewed; they are not guaranteed to stay in that inset.
- Source pocket size 26.6 mm is not a measured printed fit. Ask for actual bottle,
  printer and filament details before preparing a hardware-specific job.
- Revisions change the JSON before slicing. Export G-code + editable 3MF + all
  source/profile files, not just a screenshot. Open the 3MF in OrcaSlicer.
- These tests do not establish structural strength, material compatibility,
  support adequacy, food safety, thermal safety or successful physical printing.

model.scad is editable CAD provenance. Re-export its STL with OpenSCAD after a
CAD edit; this harness does not claim that the SCAD and STL are automatically in
sync. The STL is the actual slicing input.
