# FreeCAD acceptance evidence

Rebuild reviewed on 2026-09-20 with **FreeCAD 1.1.3**, managed **Node 22.23.2**,
Python 3.9 for standard-library tests, and the actual shared CAD Viewer 0.5.1.
Native QA ran on macOS. This is functional and visual acceptance, not a physical
manufacturing test or a study with novice users.

## Native jobs, not just the starter

| Job | Verified outcome |
| --- | --- |
| Two-face bracket from an independent brief | One manufactured solid; 17 measurements cover dimensions, two orthogonal hole patterns, fixed references, sensor clearance, work envelope and four tool-access volumes. |
| Wrong spacing | Changing the model from 50 to 54 mm while preserving the 50 mm requirement fails all four bore checks. The previous STEP and ZIP remain byte-identical. |
| Substantive revision | Change the mounting pattern to 60 mm, overall height to 52 mm and back-hole height to 37 mm. Revise the corresponding brief/acceptance values, retain unrelated requirements and rebuild. |
| Obstructed access | Moving gussets inward causes tool-access checks to fail even when the new holes are correctly positioned. Moving the gussets clear produces a passing revision. |
| Independent project | Extract the generated ZIP into a new folder. Run its bundled `tools/build.mjs` with only Node and FreeCAD; match the source revision, measured volume and requirements. Unselected private notes and `.harness` history are absent. |
| Enclosure | Two individually exported solids and 10 checks cover PCB/component dimensions, actual clearances, cable position and assembled interference. Reference volumes do not enter the exported assembly. |
| In-flight source change | A macro that alters an included input during native execution cannot publish a handoff. |

Each STEP part is reimported and checked for valid closed solids, volume, size
and position. Each STL part is reimported and checked for a closed mesh and
dimensions. Assembly contacts do not cause false failures of valid individual
bodies; specified interference checks still reject intersecting volume.

The native kernel cases additionally test misplaced, undersized, oversized,
overlong and empty-space bore probes; contained solids mistaken for clearance;
minimum/maximum gaps; misplaced bounding boxes; touching assemblies; open
or empty shapes; and failed native features retaining a valid previous shape.
The bore check requires surrounding material as well as air. A failed or still
touched document feature prevents export, even if its old Shape remains valid.

## Delivery, safety and visual checks

The full package suite has **14 passing Node test cases**, including a runner
for **9 standard-library Python cases** and **7 real-kernel Python cases**.
Native checks are explicitly skipped without `FREECAD_BIN`; a skipped native
suite is not release proof. The ordinary package checks run in Experience CI.

Tests cover strict contract validation, source path/symlink restrictions,
explicit source selection, SHA-256 fingerprints, HTML escaping, portable-tool
license notices, archive integrity, stale native output and an active build lock.
The loopback download server tests allowed downloads, denied workspace files,
symlinks, unsupported methods and a hostile Host header.

Real browser checks at 1440 px and 390 px verify loaded drawings, no horizontal
overflow, every download link and no page errors. All three SVG projections'
actual bounds must match their labeled axes/dimensions. The STEP is loaded in
the real CAD Viewer; zoom/reset and captured output are checked. Screenshots
are then visually reviewed—the browser assertions alone are not visual QA.

This process caught and corrected a rotated front projection, obstructed tool
access after widening the mounting pattern, and enclosure corners with only
0.54 mm clearance where 1 mm was required. The requirement was retained and
the geometry was corrected.

## Reproduce

From the repository root:

```sh
node --test store/agents/freecad/test/*.test.mjs
FREECAD_BIN=/path/to/freecadcmd node --test store/agents/freecad/test/*.test.mjs
```

Set `FREECAD_QA_DIR` to an existing or new scratch directory to retain native
job outputs; otherwise tests clean up their own temporary directories. Keep
these tests away from a user's real project. Native jobs have bounded timeouts.
Run network-binding tests outside sandboxes that prohibit even loopback ports.

For browser QA, run the shared CAD Viewer against a retained job, then:

```sh
HARNESS_WORKSPACE=/path/to/retained-job \
CAD_VIEWER_URL='http://127.0.0.1:PORT/?file=part.step' \
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
node store/agents/freecad/test/visual.mjs
```

The helper starts its own restricted handoff server, captures desktop/mobile
pages, drawings and the actual STEP viewer, then closes its browser and server.
Visually inspect the resulting `.harness/visual/` images. Playwright is optional
developer tooling, not a runtime dependency of the harness.

## Limits and remaining validation

No printed/machined part, physical load, temperature, electrical safety, real
fastener joint or actual commercial sensor was tested. Fixtures use synthetic
acceptance briefs. Manufacturing allowances and appropriate professional
review remain necessary. The workflow supports arbitrary macros and named
solid references; these tests are not a claim that every possible model works.
The saved native file may use generated Part features rather than Sketcher
history. Reference SVGs are not complete toleranced fabrication drawings.
Browser QA is not a full desktop-agent or novice-user end-to-end study.
