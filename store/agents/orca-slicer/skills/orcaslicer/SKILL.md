---
name: orcaslicer
description: Slice an STL with explicit OrcaSlicer JSON profiles and inspect actual G-code layers, travel, features and speeds. Use for Orca Slicer harness work.
---

# Strata workflow

1. Inspect the mesh dimensions and intended use. The included fluted vessel is an
   original dry-use demo, not a food-safe or pressure-rated design.
2. Set `slice-config.json`: mode `demo` loads the specified installed Orca
   profiles; `custom` loads explicit workspace-relative or absolute JSON files.
   Required keys: `model`, `printer`, `process`, `filament`. Parent profiles
   must be sibling JSON files. Notes in `print-config.md` do not change settings.
3. Run the real build:

   ```sh
   sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"
   ```

4. Inspect `.harness/slice.log`, `slice.json` and the three resolved profile
   files. Open `preview.html`: scrub layers, isolate one, inspect first-layer
   travel and enable custom/purge moves (hidden by default for model focus).
5. Review the exact G-code and profiles in OrcaSlicer before any proposed print.
   Report slicer estimates as estimates and unsupported preview behavior plainly.

## Runtime and limits

Tested with OrcaSlicer 2.4.2. Set `ORCA_BIN` and, if needed,
`ORCA_PROFILES_DIR`. PrusaSlicer is not a compatible fallback. The builder uses
a fresh temporary output directory, explicit flattened profiles, disables arc
fitting and post-processing, and requires one fresh plate. No machine connection
is made. Builds fail closed; an old preview is not a new successful build.

The linear single-tool inspector handles G0/G1, G20/G21, G90/G91, M82/M83 and G92.
Curves and multiple tools are rejected. Firmware retraction, leveling, offsets,
collisions and material behavior are not simulated. Travel-only heights are not
extrusion layers. Maximum preview: 32 MiB text and 250,000 linear moves.

## Verification language

Ready means “sliced and parsed,” not “safe to print.” The helper does not establish
watertightness, support adequacy or printer compatibility. Do not assert those
properties without independent evidence. Do not upload or print without explicit
user authorization. Preserve the editable mesh source and exact profile inputs.
