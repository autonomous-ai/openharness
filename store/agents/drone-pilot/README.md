# Drone Pilot · Vector

Turn a site boundary and photography requirements into an editable field-survey plan. Bring
GeoJSON or draw your own polygons, keep exclusions, choose camera geometry and compare directions.
Inspect each planned capture, split the job into sorties with routed returns, then import recorded
flight CSV to compare the plan with supplied evidence.

You keep the work: an offline planner, editable project, GIS layers, map overlay, route/photo CSVs,
SVG map and printable report. No account, map key or cloud service is required to use those files.
Existing logos and icons are included. The starter orchard is editable example geometry.

## What you can do

- Edit arbitrary named boundaries/exclusions, drag or enter precise vertices, move takeoff, lock
  approved geometry, undo revisions and save the actual project back to the workspace.
- Derive ground sampling and footprint coverage from your camera; enforce capture cadence and
  configured overlap. Compare sampled directions without changing your other requirements.
- Divide captures into nominal time budgets that include climb, descent, transits and a connected
  return. Infeasible settings produce a concrete issue; requirements are not silently relaxed.
- Import your flight CSV with explicit time, coordinate, altitude and event mapping. Inspect
  records, gaps, nearest-route distances and estimated event footprints. Keep original source.
- Export standard GeoJSON, ground-clamped KML, CSV, a printable HTML report and a complete ZIP.
  Reopen the planner offline and keep editing your own geometry and camera settings.

## Model scope

This is level-ground, nadir-camera planning within 5 km of the chosen WGS 84 origin, excluding sites that cross the 180° meridian. Camera
footprints and time are geometric/nominal estimates. Terrain, obstacles, airspace, wind, positioning
error and aircraft dynamics are not verified. Files support planning and review; there is no
vehicle connection or executable aircraft mission. Event footprints do not prove that photographs
exist or form a usable map. No photogrammetric reconstruction is included.

## Build and verify

Setup resolves Node, installs pinned package-local tools, and reuses Chrome/Chromium or installs
its local browser. In a workspace, `DRONE_DSH_DIR` points to the installed package:

```sh
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs
```

The browser's **Save to workspace** updates source and retains its previous version. An agent
revision arriving during a browser draft offers both versions. **Save file** keeps `.vector.json`;
**Export field kit** includes the current draft and all delivery files. See the
[project contract](skills/pilot/references/project.md) and [acceptance evidence](test/ACCEPTANCE.md).

The original FPV canyon code remains under `store/tools/experiences/drone-pilot.*` for future work.
Existing legacy workspaces are not automatically migrated or overwritten.

## Credit and stewardship

Original implementation and visual identity by OpenHarness contributors, maintained by
Autonomous under the [MIT license](LICENSE). Dependency notices and source references are in
[PROVENANCE.md](PROVENANCE.md). Report issues in the OpenHarness repository.
