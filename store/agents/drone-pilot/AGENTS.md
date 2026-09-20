# Drone Pilot — Vector field studio

Help a person turn their own site and capture requirements into a reviewable survey plan, then
compare supplied flight records with that plan. The deliverable is editable source, usable GIS
layers, capture/route tables and an offline report. The orchard is example geometry, not a limit
on what the person can make and not evidence of an actual surveyed or authorized location.

Read `skills/pilot/SKILL.md` and its project contract before editing. Work in `flight/project.json`;
`studio/` contains the editable planner model and UI. Build with `node tools/build.mjs`.
`DRONE_DSH_DIR` locates the installed, pinned build tools. Setup resolves Node and those tools
without asking the person to install Homebrew, global npm packages or a browser manually.

## Start from the person's work

- Establish the site boundary, exclusions, takeoff, camera dimensions, desired ground sampling
  or overlap, capture cadence and measured usable time. Use supplied GeoJSON or explicit
  coordinates. Ask for missing measurements that determine a real plan; never invent them.
- When measurements are absent, an explicitly labeled draft can help decide what is needed.
  Keep assumptions separate from supplied facts. Never present an authored example as field data.
- Preserve supplied geometry, approved/locked areas, camera specs and decisions during targeted
  revisions. Record USER/AI decisions and provenance in `flight/DESIGN.md`.
- A brief can describe any supported polygon site. Do not funnel users into seeded canyons,
  three templates or a preset genre. Extend the model when the requested work needs it, then test
  that extension. Do not claim a capability the current model cannot provide.

## Capabilities and limits

The model uses WGS 84 with local east/north meters, millimeter polygon clipping, buffered
exclusions, visibility-graph transit paths, camera footprints and capture cadence. It divides
runs into sorties with connected returns and an explicit nominal time budget. The UI edits
vertices, draws boundaries/exclusions, moves takeoff, locks geometry, compares sampled directions
and inspects individual planned captures. Changes are reversible; browser saves update source.

The modeled ground is level at takeoff elevation. The camera points down and follows each run.
Height is above takeoff. Time includes configured speed, climb/descent and a fixed allowance per
capture run. Terrain, obstacles, airspace, wind, positioning errors and aircraft dynamics have
not been checked. Do not turn geometry checks into a claim of flight safety, legality, mapping
accuracy, battery prediction or professional survey certification. No aircraft connection,
mission upload, arming or command execution belongs in this harness's current workflow.

CSV import requires explicit column, time, altitude-unit and altitude-reference mapping. Retain
original CSV bytes/text, hash and row provenance. Missing coordinates or long intervals break
tracks. A capture event remains unknown when absent. Only events with height and heading receive
an estimated footprint; those estimates do not establish image existence or quality. Reimport
source data instead of modifying normalized evidence. Synthetic fixtures are tests, never flights.

## Verify and hand off

1. Build the studio. A successful build stays `ready:false` and may show an infeasible draft.
2. Run `node tools/check.mjs`: geometry, connected paths, budgets and source-data consistency.
   It writes `.harness/survey-check.json`, not a ready verdict.
3. Open the actual viewer. Exercise the user's edited areas, relevant settings, capture inspector,
   data import and save. Preserve both drafts if an agent/browser revision conflict appears.
4. Run `node tools/export.mjs` and reopen the outputs independently. GeoJSON uses longitude,
   latitude; KML is explicitly clamped to ground. CSV height is above takeoff, with nominal time.
   These are planning/review files, not an executable aircraft mission. Test the offline planner.
5. State exactly what was checked and what remains missing. Set a ready verdict only for the
   verified software deliverable. Return the files and concrete next revision choices in the
   person's language. Never claim a real flight, customer trial or subjective “wow” from fixtures.

Keep the original canyon implementation in `store/tools/experiences/drone-pilot.*` for later work.
Existing legacy HTML workspaces remain their original experience; do not silently overwrite them.
