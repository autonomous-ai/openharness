---
name: world-builder
description: Turn a user's brief into an editable voxel environment or asset kit in Voxel Worlds. Use for original scene design, modular assets, terrain sculpting, walkable spaces, importing VOX assets and delivering GLB/VOX files with an offline studio.
---

# From an idea to a world the user can keep building

Understand the place, purpose and deliverable. A game environment, architectural massing study,
tabletop kit and miniature scene need different geometry. State sensible assumptions and produce
an original first version. Do not funnel the person into the harbor, a style enum or a seed picker.

Read [the project contract](references/project.md). The editable source is `world/project.json`.
Create meaningful named objects with local geometry; use custom palettes and physical scale.
The coding agent authors new geometry and layouts from the brief. The studio's controls edit
that geometry directly; there is no pretend generation button or remote model dependency.

## Build and revise

1. Read the existing project and `world/DESIGN.md`. Preserve supplied assets, approved objects,
   names, physical scale and decisions unless the user asks to change them.
2. Author boxes and cell edits, with generous readable forms at the chosen voxel scale. Shape
   roofs, openings, terrain and paths deliberately. Ensure that different briefs produce
   different useful structures, not recolored copies of the same scene.
3. Build: `node tools/build.mjs`. For a workspace outside the package, `VOXEL_DSH_DIR` is provided
   by the harness and resolves the installed tools. Setup installs Node and pinned local tools.
4. Open the actual viewer. Test object selection, transforms, sculpting, materials and save.
   Walk critical entrances, slopes and destinations with keyboard or touch controls. Check the
   result from the visitor's viewpoint as well as the overview. Correct geometry, not requirements.
5. A targeted revision should touch only the requested objects or decisions. Compare preserved
   objects in source and, for an approved asset, its isolated GLB/VOX export before and after.
   The studio keeps undo history; workspace saves retain prior sources in `.harness/history/`.

## Supply and save

The studio can import one static `.vox` model, including a single-instance transform graph.
Geometry, palette and orientation are preserved; the imported object is rebased for placement in
this world, at this project's physical voxel scale. Multi-model scenes, animation, absent palettes
and hidden assets fail explicitly. Specialized MagicaVoxel shaders are not reproduced.

Save to workspace writes the actual source with a revision check and rebuilds the offline artifact.
An agent revision arriving during a browser edit offers both versions instead of silently replacing
one. Keep the draft download before restoring the source. Open accepts a project file; the local
viewer also offers recent home-folder projects and an explicit path field. Portable HTML uses the
browser file picker. Save a complete `.tidelands.json` to retain editable object structure.

## Export and verify

Run `node tools/check.mjs` for geometry, a VOX round trip and finite walking-route checks. It writes
`.harness/world-check.json`, not a ready verdict. Run `node tools/export.mjs` for the delivery folder:

- GLB: Y-up, meters, named visible meshes, palette materials and emissive/transparent surfaces.
- VOX: Z-up, flattened visible cells and RGBA palette. Source object boundaries are not in VOX.
- Project JSON: named source objects, rotations, edits, locks, palette, scale, start and destinations.
- `studio.html` and `walkthrough.html`: standalone files with their runtime embedded, usable offline.
- ZIP and README: the files above, plus a finite route-check report.

Browser exports use the current draft, including unsaved changes. Isolated object exports include
all of that object's faces, even where it touches other objects. Whole-scene GLB removes buried
faces; it is not a collision mesh or physics setup for another engine. Reopen GLB/VOX with an
independent reader, inspect scale/orientation/materials, and test the offline files. Report which
checks were actually performed; geometry checks do not establish visual quality or a user's “wow.”

Do not publish a world as ready based on file presence or a screenshot alone. Keep the old working
handoff while resolving a failing requirement. Return concrete files and concrete revision options
in the user's language, without requiring them to learn a 3D editor first.
