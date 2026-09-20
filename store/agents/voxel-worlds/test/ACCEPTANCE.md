# Voxel Worlds rebuild acceptance — 2026-09-20

The new studio authors editable named objects and reusable 3D assets. Its three scenes are
original authored fixtures, not customer commissions or installed-agent prompt trials.

## Completed checks

- Real setup on Intel macOS: pinned package-local tools installed, existing Chrome discovered,
  doctor passed. Node/runtime helper and local viewer command follow normal Harness packaging.
- Sixteen package tests pass: geometry and rotations, object-local sculpting, preserving empty
  cells while painting, physical walking/collision/jump/landing, mesh winding, import bounds,
  static MagicaVoxel scene transforms, real workspace saves and stale revisions, previous-source
  history, cross-origin rejection, hidden/symlink picker boundaries and init/verdict contracts.
- Actual Chrome controls: select and rename an object, position, rotate, direct voxel painting,
  undo/redo, save source, receive an agent revision while a browser draft exists, download both
  versions, reopen source, export selected GLB/VOX, import the VOX, export a complete ZIP, keyboard
  walking, destination controls and offline walkthrough reopening. Mobile walking controls were
  rendered at 390 × 844. No browser exceptions were observed.
- Keyboard input moved the real visitor roughly 3.3 m during the timed browser pass. Pure-model
  checks also verify wall collision and jump/landing clearance. This is a finite walking sample.
- Six real deliveries: before/after harbor, civic courtyard and dungeon. Each GLB had zero errors
  and zero warnings from Khronos glTF Validator. Three.js GLTFLoader independently reopened and
  rendered every GLB, retaining all 17 / 8 / 14 named objects and physical bounds. Three.js
  VOXLoader independently reopened each flattened VOX with matching dimensions and voxel count.
- Revisions moved the skiff, raised the reading canopy and widened the west passage. The approved
  bakery, pavilion and east treasury retained identical source and isolated GLB hashes. Finite
  walking checks reached all declared destinations before and after each revision.
- The actual seven-file browser ZIP passed `unzip -t`. Its source includes the current draft.
  Studio/independent GLB renderings were visually inspected; Store images are direct screenshots
  of these working studios. The original logo/icon remains in the package, header and favicon.

Raw local evidence: `/private/tmp/tidelands-release-browser/`,
`/private/tmp/tidelands-accepted-light/acceptance.json`. CI repeats package and browser checks;
it also rebuilds and independently reads the six deliveries. Evidence paths are local artifacts,
not durable public links.

## Limits and remaining product validation

- There is no proof here of an installed coding engine independently completing arbitrary user
  briefs, real customer usability, or a subjective “wow.” These remain product validation work.
- Browser checks use Chrome on this Mac and CI Chromium. Safari/Firefox, large-world interaction
  performance, touchscreen walking with a real user and other hardware remain unmeasured.
- VOX import supports one static model/instance with palette and orientation. Multi-model scenes,
  animation, absent palettes and hidden assets are rejected. Imported coordinates are rebased for
  placement; advanced MagicaVoxel shaders are not preserved. VOX does not encode physical scale.
- GLB keeps visible meshes/materials, not editor history, collision bodies, local preview lights
  or game logic. Use project JSON for source structure and the offline studio to keep editing.
- A 1.7 m visitor, cardinal route search and finite controls do not establish physical safety,
  accessibility certification or a finished game. Three authored visual directions do not exhaust
  what the source model can express. The old implementation remains in the repository.
