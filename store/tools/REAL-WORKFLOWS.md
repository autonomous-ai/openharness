# Twelve-harness rebuild

User direction, 2026-09-20: improve all twelve withdrawn packages, **one at a
time**, then list each only when it meets the real-workflow bar. This supersedes
the earlier proposal to park ten permanently. No parallel agents.

## Release gate

For each package, implement a complete path from a new user's brief or files to
an independently usable result. Test a substantive revision, saved-project
reopening, exports and meaningful failure cases. Keep source editable. Record
exact checks, actual tool versions, known limits and any remaining user/hardware
validation. A passing starter or a new screenshot alone is not release evidence.

Do not flip `listed` for uncompleted packages. Publish through the normal PR and
catalog workflow and verify the live catalog after each accepted release.

| Order | Package | Intended complete workflow | Status |
| --- | --- | --- | --- |
| 1 | freecad | Measurements and fit requirements → checked assembly, individual parts, editable native/source project and handoff | Implemented and validated; relisted in this change. See [acceptance evidence](../agents/freecad/test/ACCEPTANCE.md). |
| 2 | score | Musical brief and player constraints → revised score, audible mix, individual parts and practice exports | Implemented and validated; relisted in this change. See [acceptance evidence](../agents/score/test/ACCEPTANCE.md). |
| 3 | openscad | Dimensions and fabrication constraints → parametric parts, verified variants and usable exports | Implemented and validated; relisted in this change. See [acceptance evidence](../agents/openscad/test/ACCEPTANCE.md). |
| 4 | orca-slicer | User mesh and explicit machine/material profiles → compared slicing options and reviewed toolpath handoff | Implemented and validated; relisted in this change. See [acceptance evidence](../agents/orca-slicer/test/ACCEPTANCE.md). |
| 5 | data-studio | User data and a question → saved analysis, source-linked results and repeatable report | Not started; unlisted |
| 6 | gis | User geographic data and a decision → reproducible spatial analysis and exported results | Not started; unlisted |
| 7 | web-studio | User application brief → useful app with durable data and a runnable handoff | Not started; unlisted |
| 8 | sheet-docs | User document/data requirements → editable, recalculated and reconciled deliverables | Not started; unlisted |
| 9 | godot-studio | Original game brief → revised gameplay, verified playable build and distributable project | Not started; unlisted |
| 10 | quantum-studio | User circuit/experiment question → reproducible experiment, quantitative checks and portable program | Not started; unlisted |
| 11 | firmware-studio | Target device and behavior → tested logic, compiled firmware and explicit hardware-test handoff | Not started; unlisted |
| 12 | home-assistant | Actual entities and desired behavior → engine-validated automation and approved installation workflow | Not started; unlisted |

The final two require special care: a simulated device is not tested hardware,
and local YAML parsing is not a real Home Assistant run. Obtain authorization
before accessing a user's physical device or live installation. Missing access
must be reported rather than converted into a passing release claim.
