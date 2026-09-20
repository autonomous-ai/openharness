# Provenance

The wrapper, strict brief/mesh/G-code inspection, Strata comparison viewer,
archive/server helpers, Bottle Bench rack and spacer test fixture are original
OpenHarness work under the included MIT license. Mesh/archive/transaction helpers
are adapted from the original OpenHarness OpenSCAD and Score harnesses; each
package carries its own standalone copy and license.

The rack STL was regenerated from `template/model.scad` with OpenSCAD 2021.01.
Its geometry matches the Everyday six-bottle rack in the OpenSCAD harness's
acceptance workflow. The spacer STL was generated from its adjacent original
test SCAD. They are dimensional examples, not physically fit- or load-tested
products. Screenshots show actual native slices in the working viewer.

[OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) is separately installed,
AGPL-3.0 software derived from PrusaSlicer. No Orca binaries, source code or
bundled printer/filament profiles are committed to this package. Tested with
OrcaSlicer 2.4.2, using its own CLI and native 3MF exporter/importer.

At runtime, the chosen installed or user-exported JSON presets are resolved.
Generated portable projects contain flattened copies of those selected settings
and a PROFILE-NOTICES file linking to upstream source/license. That profile data
is not relicensed as OpenHarness MIT code. Printer connection fields and
credentials are rejected/removed; post-processors are never executed.

Primary upstream CLI documentation:
[CLI mode](https://github.com/OrcaSlicer/OrcaSlicer/wiki/cli_mode),
[CLI actions](https://github.com/OrcaSlicer/OrcaSlicer/wiki/cli_actions).
This implementation was also checked against the installed 2.4.2 `--help`.
No upstream endorsement or stewardship is implied.
