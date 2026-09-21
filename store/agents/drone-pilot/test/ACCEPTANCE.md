# Vector acceptance — 2026-09-20

This release replaces the starter canyon with an editable field-survey planner and recorded-data
workflow. Old canyon code and the original logo/icon remain in the repository. Store listing is
restored for this rebuild. No real flight, customer trial or installed-agent prompt completion is
claimed by these authored fixtures.

## Local evidence

- `node --test test/*.test.mjs`: geometry, camera/capture budgets, three site shapes, split runs,
  explicit infeasibility, coordinate limits, undo, CSV quoting/units/time/missing data, original
  source consistency, package setup/doctor, source saves/conflicts/history and picker boundaries.
- `test/browser.mjs`: actual Chrome edits (vertex drag, locked geometry, undo/redo, camera settings,
  sampled direction comparison and individual capture inspection), save, concurrent agent/browser
  drafts, supplied GeoJSON, drawn exclusion, explicit CSV mapping, recorded-sample inspector,
  UTF-8 BOM and SHA-256 preservation, kit download, offline reopening/editing and 390px layout.
- `test/acceptance.mjs`: all six delivered offline planners reopened in Chrome with no page errors.
  Three original briefs and three targeted revisions; the approved geometry hashes remain equal.
- `test/verify-delivery.py`: independent GEOS/Shapely 2.0.7 boundary insets/exclusions, complete route
  containment, route distance, home returns, footprint union coverage; stdlib readers validate
  exported GeoJSON geometry, CSV column/order/values, KML, ZIP contents and retained original CSV.
  Geometry containment tolerance is 3 mm for Clipper/GEOS offset and rounding differences.
- Normal setup and doctor passed on this Mac. Harness's source conformance check passed.
  All 416 CLI Store/conformance tests passed after restoring required credits for this package
  and Voxel Worlds. Shared model/viewer checks passed. Generated artifacts, branding and catalog
  validate. CI also runs the package/browser/six-delivery/independent-reader checks on Linux.
- Printable reports were rendered by Chrome to A4 and visually reviewed via Poppler page images.
  The report contains a real SVG map, calculations, assumptions, source provenance and page labels.
  Mobile navigation, report pagination and cross-runtime coordinate comparison bugs found during
  review were corrected.

| Authored brief | Captures before → after | Sorties before → after | Targeted revision | Preserved geometry |
| --- | ---: | ---: | --- | --- |
| Alder Orchard | 336 → 406 | 2 → 2 | Lower height, rotate runs, expand margin | Irrigation pond |
| Works Yard | 341 → 350 | 4 → 4 | Move equipment exclusion, reorient runs | Storage compound |
| Estuary Plots | 316 → 324 | 3 → 6 | Extend east plot, shorten usable time | West plot and reed bed |

All six have 100% ideal geometric footprint coverage of the supplied target, independently
recomputed. This is not a percentage of verified photographs, mapping quality or actual flight
coverage. The after-stage CSVs are explicitly synthetic test fixtures with intentional gaps,
missing capture state and a capture missing heading. One fixture's connected recorded segment
crosses the inset flight region; the report exposes that instead of concealing it.

Reproduce from the repository root:

```sh
sh store/agents/drone-pilot/toolchain/setup.sh
node --test store/agents/drone-pilot/test/*.test.mjs
node store/agents/drone-pilot/test/browser.mjs
node store/agents/drone-pilot/test/acceptance.mjs
python3 -m venv /tmp/vector-reader
/tmp/vector-reader/bin/pip install shapely==2.0.7 numpy==1.26.4
/tmp/vector-reader/bin/python store/agents/drone-pilot/test/verify-delivery.py work/experience-evidence/vector-acceptance
node store/agents/drone-pilot/test/showcase.mjs work/experience-evidence/vector-acceptance
```

The actual local release outputs are under `/private/tmp/vector-browser-release/` and
`/private/tmp/vector-acceptance-published/`; earlier intermediate runs remain separate. They are
not committed as artificial user data. The Store screenshots are captured from the real studio.

## Scope and remaining evidence

This is small-site level-ground/nadir planning, using supplied measurements and nominal time.
No terrain, obstacle, airspace, aircraft-dynamics, wind or navigation-error model is validated.
There is no photogrammetric reconstruction, executable mission, vehicle connection or command.
KML is ground-clamped; CSV heights are above takeoff. Split antimeridian sites before planning.

Shapely/CSV/XML import is independent software evidence, not a native QGIS/Google Earth or ground-
station trial. Chrome on this Mac and CI's browser are covered; other browsers, actual phones,
large input performance and real customer/installed-agent tasks remain unmeasured. The studio
supports manual CSV mapping; it does not claim automatic support for every vendor's binary log.

A 10-micrometer tolerance in normalized local positions handles native/browser Math.sin/cos
rounding. Original CSV bytes (valid UTF-8, including BOM), hash, events, time and row provenance
are retained. This numeric tolerance is not a claim of geographic measurement accuracy.
