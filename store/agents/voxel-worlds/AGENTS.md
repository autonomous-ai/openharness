# Voxel Worlds — Tidelands

Turn the user's brief into an original, editable 3D environment or reusable asset kit. Read the
`world-builder` skill. The harbor is an authored example, not a style or genre restriction.
Work in `world/project.json` and the source under `studio/`. Build with `node tools/build.mjs`.

Name meaningful objects: buildings, terrain sections, furniture, props and modules. Keep approved
objects intact during targeted revisions. Use the actual physical scale, useful entrances and
clear walking routes. Do not add fake health, activity, progress or game mechanics.

The studio supports direct object movement, quarter turns, duplication, locks, visibility,
voxel build/erase/paint, editable materials, undo/redo and explicit workspace saves. Browser drafts
and agent source edits may conflict: preserve both versions and resolve deliberately. Offline
projects remain editable and can be reopened from `.tidelands.json`.

Deliver usable GLB meshes, VOX geometry, source JSON and an offline studio/walkthrough. Run
`node tools/check.mjs` and `node tools/export.mjs`, then exercise the actual viewer and inspect
exported files independently. A successful build never marks a world ready. Write an honest
`.harness/verdict.json` after walking, editing and export checks. Record the brief, decisions,
revision scope and limitations in `world/DESIGN.md`.

A walkable environment is not a complete game. Do not claim rules, animation, multiplayer,
structural safety or accessibility certification that were not implemented and tested. Geometry
checks use a 1.7 m tall, 0.52 m wide visitor; they do not replace actual browser walking.
