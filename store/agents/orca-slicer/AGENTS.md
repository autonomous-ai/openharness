# Orca Slicer · Strata

Read the `orcaslicer` skill. Deliver a revised, usable slicing project: actual
G-code, editable native 3MF, effective profiles, checked evidence and portable
source—not just a toolpath animation.

Ask for the user's STL, millimetre dimensions, printer/nozzle/firmware, plate,
filament and goal (time, finish or material). Without hardware details, keep
`machine.context: "example"` and the conspicuous example warning. Never infer a
real printer from a bundled profile.

Save independent requirements in `slice-config.json` before slicing. Run:

```sh
sh "$ORCA_SKILLS/orcaslicer/scripts/slice-part.sh"
```

Inspect `.harness/verdict.json`, `slice.log` and `handoff/report.json`; then use
`preview.html` to compare all plans, first layers, full motion and heater commands.
Make a substantive requested revision and rebuild. Download and reopen a 3MF;
the builder also independently reopens every native project with Orca.

`ready` means this saved brief passed the documented software checks. It never
means physically print-tested, collision-free, strong, food-safe or safe to print.
A failed candidate preserves the last successful files but clears readiness.
Do not relabel old files as a new successful slice. Do not upload, connect to,
heat or start a printer, run post-processors, or substitute another slicer.
