---
name: pilot
description: Create and revise field-survey plans from supplied GeoJSON boundaries, exclusions, camera geometry and capture requirements. Use Drone Pilot for editable routes and sorties, recorded-flight CSV analysis, and portable GIS, CSV and report delivery.
---

# From a site to a field kit

Read [the project contract](references/project.md). Start with what the person needs to document
and the measurements they can supply. Translate ground-sampling or overlap requirements into
camera geometry. Preserve their boundary and approved exclusions. Explain missing inputs in
plain language; do not fabricate a georeferenced site, aircraft specifications or flight records.

## Author and revise

1. Read `flight/project.json` and `flight/DESIGN.md`. Distinguish supplied measurements, user
   decisions and explicit draft assumptions. The agent can create original polygon geometry;
   the starter orchard is only an example. Importing a GeoJSON file can replace or extend a site.
2. Author named boundary/exclusion layers and takeoff in local east/north meters. Keep the WGS 84
   origin and locked geometry stable during targeted edits. Camera sensor width is across a run;
   sensor height is along it. Line angles are counterclockwise from east.
3. Run `node tools/build.mjs`. `DRONE_DSH_DIR` resolves tools for materialized workspaces. The HTML
   embeds its runtime; no CDN, map key or cloud service is needed to use or share the planner.
4. Resolve infeasibility explicitly: cadence, narrow geometry, disconnected paths or an inadequate
   return budget. Do not silently relax requested height, speed, overlap, margin or reserve.
5. Compare directions with the UI when useful. It samples 12 angles in 15-degree steps plus the
   current direction and reports time and coverage. This is not a global route optimization.
   Photo footprints and source paths are inspectable. Never imply that a straight geometric
   segment models the aircraft's turn radius, acceleration or navigation error.

The UI supports named area edits, direct vertex dragging, new polygons, precise coordinate edits,
geometry locks, moving takeoff, camera/cadence settings, undo/redo and a take-home project file.
Workspace saves keep prior source in `.harness/history/`. Source changes arriving while the user
has a draft offer both versions. Do not overwrite either without an explicit save/restore choice.
Offline HTML has the same model and browser file import/export; native path opening uses only the
local viewer's explicit home-folder project picker.

## Inspect recorded evidence

Import a CSV with explicit latitude/longitude and time columns. Select elapsed seconds,
milliseconds, or ISO 8601 timestamps with timezone. Altitude requires meters/feet and takeoff/AMSL
reference; AMSL requires supplied takeoff elevation. Heading is degrees clockwise from north.
Battery is a percentage. Events use 1/0, true/false or yes/no, with blank meaning unknown.

The retained original CSV and SHA-256 establish provenance. Row numbers and missing-coordinate
breaks remain in the normalized records. Time gaps above the selected continuity threshold are
not connected. Compare nearest-route distances with all planned routes or one sortie, inspect
individual records and report samples/segments outside the inset region.

Footprint estimates need an event flag, positive height and heading, plus the current camera and
level-ground/nadir assumptions. Do not infer events from ordinary telemetry, fill unknown fields,
call nominal footprints observed images or claim an orthomosaic/photogrammetric reconstruction.
The model does not process photographs. Reimport the original source to revise its mapping.

## Deliver and verify

Run `node tools/check.mjs` for source, geometry and budget checks, then `node tools/export.mjs`:

- `.vector.json`: editable boundaries, settings, camera and retained flight source, if supplied.
- `planner.html`: one offline file with editing and all required runtime/license text embedded.
- `survey.geojson`: source polygons, inset region, routes, planned captures, footprint estimates
  and gaps. Recorded paths/estimated event coverage are separate named features when present.
- `overlay.kml`: map overlay with ground-clamped site and routes; not an altitude or mission file.
- `planned-photos.csv` / `planned-route.csv`: explicit coordinates, height above takeoff and nominal
  times. CSV values are review data, not commands or tested autopilot configuration.
- `site-map.svg`, `report.html` and `report.json`: portable map and calculations; print HTML to PDF.
- Original and normalized recorded CSV when supplied, full dependency licenses, README and ZIP.

Browser exports use the current draft. Reopen GIS/CSV/HTML with an independent reader and review
scale, coordinate order, dates, gaps and source retention. Test the actual viewer edits and an
offline reopen. Record exact commands and outcomes. Unit/schema checks do not establish native
GIS or ground-station imports, a completed real flight, a customer's success or visual quality.
