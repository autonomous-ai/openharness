# Orca Slicer harness

Read the `orcaslicer` skill. Use `slice-config.json` as the executable profile
contract and `model.stl` as the input mesh. Build with:

```sh
sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"
```

Show the actual toolpath in `preview.html`. Inspect the first layer, layer stack,
travel/custom moves, speed coloring, slicer estimates and recorded profile inputs.
The default Prusa profile is a labeled demo, never a claim about the user's printer.
Ask for the actual machine and material before preparing a hardware-specific file.

`ready` means freshly sliced and parsed, not watertight, collision-free, printable,
or print-tested. Never fake a successful receipt, select an old G-code by mtime,
or substitute PrusaSlicer for OrcaSlicer's different CLI. Preserve old artifacts on
failure but write a new failed verdict. Do not print, upload, or run post-processors.
