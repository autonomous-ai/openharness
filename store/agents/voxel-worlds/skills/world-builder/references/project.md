# Tidelands project contract

`world/project.json` uses `spec: "tidelands/2"`, a stable lowercase ID, title, original brief,
`size: [width,height,depth]` in voxels and `unit` in meters per voxel. Y is up; coordinates start
at zero. The dimensions are integers 4–128 with at most 1,048,576 total cells. Unit is 0.01–10 m.
Small-scale miniatures may not fit the 1.7 m visitor; use the orbit view and label that limitation.

Materials have unique IDs 1–255, name, hex `color`, boolean `solid`, `opacity` 0.05–1 and `emission`
0–1. ID 0 means air. Materials affect every object using that ID; duplicate a material when a
revision must remain local. `solid` affects the studio visitor, not exported engine physics.

Each object has a unique stable `id`, descriptive `name`, local `size`, world `origin`, `rotation`
0–3 (quarter turns around Y), `hidden`, `locked`, `boxes` and `edits`. Rotated bounds must fit the
world. Boxes are `[x,y,z,width,height,depth,materialId]`; cell edits are `[x,y,z,materialId]`.
Apply boxes in order, then cell edits in order. Air carves that object's geometry. Later objects
win at occupied cells; their air never deletes earlier objects. Use an object of its own for each
building, prop, terrain section or reusable module. Do not make the entire world one object.

Source limits: 128 objects, 8,388,608 total local cells, 16,777,216 box fill operations, 100,000
geometry commands and 12 MB JSON. Mesh/export limit: 350,000 exposed faces. Split complex work
into related projects or assets instead of bypassing budgets. Sculpting bakes an object's quarter
turn into its cells and may enlarge its local bounds while preserving existing world positions.
Painting changes existing cells only. Erasing a foreground object may reveal an object behind it.

`spawn` is `{position:[x,y,z],yaw}` where position is the visitor's feet; yaw 0 faces +Z, PI faces
−Z. Height is 1.7 m, width 0.52 m, step 0.45 m. Optional `stops` contain unique ID, name,
description and foot position. Studio stop buttons reposition the visitor; they do not prove a
walkable route. `light` is 0–1 around a day and `notes` describe useful handoff details.

The stored JSON is the source of truth. The built HTML embeds a validated snapshot and revision.
A browser save uses that revision and retains a prior source. An exported JSON preserves current
object data, including imported-asset provenance, but not temporary browser undo stacks. Generated
GLB positions are meters and use standard glTF colors; VOX exchanges Y/Z and reflects depth to
preserve handedness. VOX has no physical-scale field, so keep the README and source project.
