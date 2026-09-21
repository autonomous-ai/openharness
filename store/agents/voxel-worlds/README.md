# Voxel Worlds — Tidelands

![Voxel Worlds logo](brand/logo.svg)

Turn an idea into an editable 3D environment and a reusable asset kit. Describe a harbor, a civic
courtyard, a dungeon module or a place of your own. The agent authors the geometry; you can move
objects, sculpt voxels, change materials, walk the result and take it into other tools.

The studio supports named objects, snapping movement, quarter turns, duplication, locking,
visibility, build/erase/paint brushes, custom materials, physical scale, undo/redo and lighting.
Save source to the workspace, reopen complete projects, and retain both versions when an agent
revision conflicts with a browser draft. A single static MagicaVoxel asset can be imported with
its palette and orientation, including a single-instance transform graph.

Export a named GLB in meters, a flattened VOX, individual reusable assets, the source project and
an offline editable studio/walkthrough. A ZIP collects the complete handoff. The harbor is an
authored example; there is no fixed style selector. The earlier island implementation is preserved
under `store/tools/experiences/voxel-worlds.*` for reference.

## Use and build

Harness setup installs pinned package-local Three.js, esbuild and browser tools. Node comes from
the shared runtime helper when needed. No CDN, paid API or network is required by the built HTML.

```sh
sh toolchain/setup.sh
# Inside a materialized workspace (VOXEL_DSH_DIR is set by Harness):
node tools/build.mjs
node tools/check.mjs
node tools/export.mjs
```

Edit `world/project.json`; source modules live under `studio/`. The [project contract](skills/world-builder/references/project.md)
defines limits and coordinates. The local viewer only accepts same-origin saves, verifies source
revisions and keeps history. It runs trusted workspace code; it is not a sandbox for hostile scripts.

## What the files preserve

GLB retains visible geometry as named meshes with materials, in meters, Y-up. VOX flattens geometry
and colors, Z-up. The source JSON keeps object structure and editing settings. Isolated object
exports retain faces hidden by other objects in the scene. MagicaVoxel import supports one static
model/instance; it rejects multi-model scenes, animation and missing palettes. Imported placement
is rebased to the object bounds; specialized shaders are not reproduced.

This is an environment and asset authoring tool. Walking uses a simulated 1.7 m visitor; it does
not supply game rules, multiplayer, rigging, construction validation or accessibility certification.
Geometry checks do not establish visual quality. See [acceptance evidence](test/ACCEPTANCE.md)
for the tests actually performed and remaining validation.

The original [logo and icon](brand/) are retained in the Store, studio and favicon. Three.js and
runtime provenance are recorded in [PROVENANCE.md](PROVENANCE.md).

## Credit and stewardship

Original implementation and visual identity by OpenHarness contributors, maintained by
Autonomous under the [MIT license](LICENSE). Dependency notices and source references are in
[PROVENANCE.md](PROVENANCE.md). Report issues in the OpenHarness repository.
