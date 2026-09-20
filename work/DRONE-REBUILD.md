# Drone Pilot — field-survey rebuild

The implementation is complete and locally reviewed; publication is the next step. The old
canyon implementation remains under `store/tools/experiences/drone-pilot.*`. The rebuilt package
restores listing only for an editable planning/data/delivery workflow.

Vector accepts actual GeoJSON or drawn georeferenced boundaries, exclusions, takeoff and camera
measurements. It computes nominal footprints, capture cadence, connected routes and time-budgeted
sorties with returns. Users can edit and lock geometry, compare sampled directions, inspect
individual captures, undo, save source with conflict/history protection, and retain a portable kit.
Recorded CSV import requires explicit columns, units and time interpretation; preserves source
bytes/hash and missing-data boundaries; and estimates footprints only from supplied event flags,
height and heading. No vehicle connection, mission upload, terrain/airspace verification or
photogrammetry is claimed.

See [the acceptance record](../store/agents/drone-pilot/test/ACCEPTANCE.md). Key local evidence:
`/private/tmp/vector-browser-release/`, `/private/tmp/vector-acceptance-published/` and
`/private/tmp/vector-pdf-published/`. Three distinct sites and targeted revisions, six independent
GEOS/CSV/XML/ZIP checks, real Chrome UI and offline exports. Printed reports visually reviewed.
Tests exposed and fixed floating-point source-save mismatch, mobile navigation overflow and PDF
page splitting. Original UTF-8 CSV bytes (including BOM) are preserved and verified.

The required credit section was restored in Voxel Worlds while running the full Store tests;
no Voxel runtime change is included here. Source conformance and all 416 CLI Store/check tests pass.
Existing branding remains, with new actual Store screenshots. Publishing still needs the PR,
required CI, merge, catalog publication, public byte checks and normal install verification.

Next after Drone publication: Game Master, then Lab Bench. Keep each unlisted until its own
useful workflow and outputs are verified. User has authorized sequential rebuild and publication.
