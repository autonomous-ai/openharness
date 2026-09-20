# Vector 2 project contract

`flight/project.json` is a JSON object with `schema:"vector/2"`, stable `id`, `title`, `brief`,
`origin:[longitude,latitude]`, `home:[east,north]`, `areas`, `camera` and `settings`.

Coordinates are WGS 84 projected through ECEF into the origin's east/north tangent plane.
Each local point stays within 5 km; latitudes are between 85° south/north. Precision is not a
survey-accuracy guarantee. Split sites crossing the 180° meridian before planning; this exporter
does not split polygons at the antimeridian. Polygon clipping rounds to integer millimeters.

Each area is `{id,name,kind,locked,ring}`. Kind is `boundary` or `exclusion`. Ring is an open array
of `[east,north]` vertices in meters; validation normalizes orientation and redundant closure.
Use 3–128 vertices, simple nonintersecting edges and at least 1 m². Up to 32 areas and 200 source
vertices are supported; routing rejects more than 350 offset corners. Names and IDs are stable.
Locks constrain browser edits and indicate geometry the agent should preserve.

Camera fields are `name`, `sensorWidth`, `sensorHeight`, `focalLength` (mm), `imageWidth`,
`imageHeight` (whole pixels), `minInterval` (seconds). Sensor width lies across the capture run.
Settings: `height` (meters above takeoff), `speed`, `climbSpeed`, `descentSpeed` (m/s), `angle`
(0–179.9°, counterclockwise from east), `frontOverlap`, `sideOverlap` (fractions 0–.95), `margin`
(meters), `usableMinutes`, `reservePercent`, `turnSeconds` (fixed allowance per capture run).

The model computes ideal width/height as distance × sensor dimension / focal length. Ground
sampling distance derives from the pixel dimensions. Parallel line and photo spacing honor
requested overlap along regular runs. Camera cadence may make a setting infeasible. Photographs
are centered within clipped runs, connected by visibility-graph transits, and partitioned across
sorties. Budget includes return, climb/descent and allowance. Up to 1,000 grid rows, 3,000 planned
photos and 80 sorties; split larger jobs. Coverage is the union of ideal footprints intersected
with boundary minus exclusions. Boundaries/exclusions can leave uncovered gaps.

Optional `log` is produced by `studio/log.mjs` `importFlight(raw,name,mapping,origin)`. Keep `raw`,
`sha256`, `mapping`, `sourceRows`, `missingCoordinates`, `startTime`, and `records` unchanged.
Records contain elapsed seconds, local point, altitude in meters above takeoff, heading clockwise
from north, battery percentage, capture true/false/null, original row and `breakBefore`.
`comparisonSortie` and `maxGap` are analysis settings. Source consistency is verified on build
and save; only sub-clipping numerical differences between JS runtimes are tolerated.

CSV files are at most 3 MB / 12,000 samples / 80 columns; a whole project is at most 8 MB.
Time must increase strictly. Missing coordinate rows remain counted and break the track. At most
3,000 recorded capture events. Do not edit normalized evidence to make it agree with the plan.

`node tools/build.mjs` validates source and creates standalone `flight/index.html`. It intentionally
allows a structurally valid but infeasible draft, which shows its issue in the UI. `check.mjs` and
`export.mjs` require a feasible plan. A build/check does not set the artifact ready.

Source bridge: GET/PUT `/api/project`, optimistic `If-Match` revision, prior source backups.
The viewer compiles the next preview before replacing source, so a broken studio build leaves
existing files intact. GET `/api/files` lists visible recent project files; POST `/api/open`
opens an explicitly selected `.vector.json` in a draft. No aircraft or external service endpoint.
