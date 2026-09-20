# OrcaSlicer real-workflow acceptance

Validated 2026-09-20 with actual OrcaSlicer 2.4.2 on macOS, Node 22.23.2,
OpenSCAD 2021.01 for original STL generation, and Chromium for browser checks.
No physical printer was connected, heated, uploaded to or tested.

## Repeatable checks

```sh
node --test store/agents/orca-slicer/test/*.test.mjs
ORCA_BIN=/path/to/OrcaSlicer node --test store/agents/orca-slicer/test/*.test.mjs
```

The first command runs 18 unit/transport/server tests and explicitly skips the
three native cases when ORCA_BIN is absent. The native run passed **21/21**.
Use ORCA_PROFILES_DIR if Orca's bundled profiles are not beside its app binary;
ORCA_EVIDENCE_DIR preserves generated native workspaces at a chosen location.
The standard slice-part.sh entrypoint was also exercised successfully.

## 1. Six-bottle rack: compare and independently reopen

A closed 87.8 × 59.2 × 18 mm STL, six 26.6 mm pockets, 2.4 mm floor.
The saved brief states example Prusa MK3S, one 0.4 mm nozzle, Marlin, PLA,
High Temp Plate, 250 × 210 × 210 mm bed, 5 mm model/support-centerline inset,
190–230 °C nozzle and 50–70 °C bed target envelopes, 8-hour / 80 g budgets.

| Plan | Layers | Slicer time estimate | Filament estimate |
| --- | ---: | ---: | ---: |
| Draft · 0.28 mm / 2 walls / 10% gyroid | 65 | 1h 34m 34s | 27.85 g |
| Everyday · 0.20 mm / 3 walls / 15% gyroid | 90 | 2h 45m 12s | 32.12 g |
| Fine · 0.16 mm / 3 walls / 15% gyroid | 112 | 3h 20m 26s | 33.15 g |

75 checks per plan, 225 total: effective and emitted settings, bed geometry,
actual heater targets/shutdown, positive feeds, first/top heights, layer counts,
centerline bounds and budgets, exact native 3MF embedded-G-code bytes/MD5, and
native project reopening with STL/settings re-export. The normal plans contain
145,786 / 311,427 / 386,144 moving linear segments respectively; these are not
the previous 250,000-move-limited demo.

A default implicit plate was observed to produce 35 °C bed commands during
development. The checked workflow now selects High Temp Plate explicitly and
requires the effective profile, emitted settings and actual M140/M190 targets
to agree with the saved temperature envelope (60 °C in this example).

The ZIP was extracted into a separate directory and rebuilt using only its
standalone helper, source and flattened profiles plus installed Node/Orca.
It preserved the semantic source revision and checked geometry/layers; an
undeclared private note was absent. No repository-relative runtime dependency.

An exported Everyday 3MF was independently re-sliced in Orca with a new data
directory. All effective settings agreed (see normalization below), model
centerline bounds agreed within 0.03 mm, layers stayed 90 and material stayed
32.12 g. The new time estimate was 2h 44m 50s, 22 seconds lower (0.22%).
The test permits at most 1% estimate variation. This is not a claim of
byte-identical regenerated paths; the original G-code embedded in each native
3MF is separately verified byte-for-byte.

## 2. New spacer, exported profiles and a meaningful revision

A different original STL: 24 mm outside diameter, 8.4 mm bore, 6 mm high,
centered around negative and positive source XY. Explicit X rotation 180°
and bed translation are applied before slicing. Printer/process/filament
profiles are workspace JSON exports, not installed-path lookups.

Two native plans pass 150 checks. The Everyday plan is revised from three walls
at 0.20 mm to four walls at 0.16 mm with five top layers:

- Before: 30 layers, 8m 33s, 1.73 g.
- After: 37 layers, 10m 53s, 1.93 g.
- Unchanged Draft: 22 layers, 6m 5s, 1.58 g.

The revised native project's effective settings agree and reopen successfully.
The spacer has its own brief, assumptions and notes; no inherited rack claims.

Wrong nozzle, wrong dimensions, smaller declared bed, a contradictory temperature
envelope and an impossible time budget all fail. After each failure, readiness
is false and the prior preview/project ZIP bytes are unchanged. Rebuilding the
valid revision succeeds again. A separate real-native wrapper changes a declared
source note during slicing; the source hash gate prevents publication.

## Browser and transport evidence

Both cases were tested inside the actual shared isolated-web-viewer:
an opaque-origin iframe with scripts/downloads enabled, not same-origin storage.

- All five plans switch and verify G-code SHA-256 before rendering.
- First layer, isolated/stacked layers, travel/custom paths, top/orbit projection
  and speed colors work. Full motion displays exactly every parsed moving
  segment, including travel-only Z hops and final parking.
- Five G-code and five native 3MF downloads match their checked hashes.
  Two complete-project ZIPs and two review JSONs were downloaded.
- Review restore reproduces selected plan/view/notes; a mismatched revision is
  rejected. Review is not printer authorization.
- 1600 px desktop and 390 × 844 mobile checks: no JS errors or horizontal
  overflow. Actual screenshots were visually inspected.
- Portable loopback server serves only named generated artifacts, denies
  undeclared source/hidden files/symlinks and non-loopback Host headers, rejects
  POST, and bounds downloads to 32 MiB.
- The extracted ZIP's own preview server was also tested in Chromium under its
  real content-security policy: all three plans, hashes, downloads, review
  save/restore and mobile layout passed without console errors.

Unit/transport checks additionally cover units and extrusion modes, G92,
unretraction debt, full-motion retention, malformed/unsupported commands,
conflicting settings, wrong heater commands despite valid profile metadata,
missing shutdown, strict schema/bounds, profile inheritance/cycles/credentials,
source changes/symlinks, ZIP CRC/path checks, build locks, a missing native engine,
an empty “successful” CLI output, and refusal to call legacy demo configs ready.

## Known boundaries

Ready means documented software checks passed, not “safe to print.”
One closed STL / one extruder / rectangular zero-origin bed / Marlin or Marlin 2.
No exclusion zones, named firmware macros, arcs, multiple tools, firmware
retraction, arbitrary post-processing or automatic printer connection.

Native geometry reopening compares closure, positive volume, shell/triangle
counts, dimensions (0.03 mm) and volume (1e-5 relative, minimum 0.05 mm³).
It is not a general mesh-equivalence or self-intersection proof.
All effective settings must agree; only absent versus [] for the non-slicing
upward_compatible_machine preset-catalog metadata is normalized. The 3MF's
project-schema version is distinct from the exported engine version.

Centerlines are not bead-footprint, collision or machine-envelope simulation.
Custom purge can be outside the model inset and is displayed separately. Homing
is drawn at zero; real offsets, leveling, firmware flow/speed/pressure behavior,
thermal response, support adequacy, strength and physical fit remain unverified.
The SCAD source is editable provenance; the build slices the saved STL and does
not claim automatic SCAD/STL synchronization.

## Local evidence retained for release review

QA root: `/private/tmp/harness-orca-workflows.5ILEon`.

- `release-native/orca-rack-9f5xBX`: final rack, acceptance receipt.
- `release-native/orca-portable-u4TLWL`: standalone rebuilt ZIP.
- `release-native/orca-project-reslice-r26UHz`: independent 3MF re-slice/log.
- `release-native/orca-race-ZsjEpN`: rejected concurrent source edit.
- `final-spacer/orca-spacer-7OA3TQ`: revised independent spacer and five negatives.
- `release-browser-rack` / `release-browser-spacer`: actual downloads,
  screenshots and machine-readable browser receipts.

These temporary directories are local evidence, not package dependencies.
Registry/catalog/publisher checks passed 433/433; package conformance, skill
validation, generated artifacts/branding and whitespace checks passed.
