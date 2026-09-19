# Print intent

The included fluted vessel and slice-config.json are a **demo for toolpath exploration**, not a recommendation for your printer. No printer is connected.

The executable settings are the printer, process and filament JSON profiles named in slice-config.json. This Markdown file is notes only; changing it does not change the slice.

For a real project, set mode to "custom", provide your OrcaSlicer-exported profile paths (relative to the workspace or absolute), and confirm printer model, nozzle, bed dimensions, firmware flavor, material temperatures, cooling, layer height, walls and supports. Inherited profiles must resolve in your installed OrcaSlicer. Do not copy the demo profile onto an unrelated printer.

Run: `sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"`

The helper loads all three profiles explicitly, arranges one mesh onto the bed, disables arc fitting for the linear inspector, disables post-processing commands, and never uploads or prints. Review machine-specific start/end G-code and geometry in OrcaSlicer before printing.
