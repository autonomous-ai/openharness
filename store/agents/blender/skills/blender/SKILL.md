---
name: blender
description: Model objects and scenes with Blender's Python (bpy) headless — primitives, modifiers, materials, collections, cameras, lights, animation — export glTF the 3D pane shows live, render stills and turntables, export STL. Use for any request that ends in a 3D model, a rendered shot or a glTF.
---

# blender

Blender runs here as a Python module (`bpy`, pinned): everything Blender does, no window. Scripts
live in `scenes/`, run with `$BLENDER_PYTHON`, and `harness_blender` (on `PYTHONPATH`) gives you the
scene, the camera, the export, the renders and the report in one import.

## Build, export, render, verdict

```bash
"$BLENDER_PYTHON" scenes/hello.py                        # builds → out/model.glb, out/preview.png, out/turntable.mp4, out/report.json
"$BLENDER_PYTHON" "$BLENDER_TOOLCHAIN/verdict.py"        # judges out/ → the pane header, and which glTF the pane opens
```

```python
import bpy
from harness_blender import fresh, frame_all, export_glb, render, turntable, export_stl, report
fresh()                                    # empty scene, millimetres, Workbench matcap
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=45, depth=100, location=(0, 0, 50))
body = bpy.context.active_object
body.name = "Mug"                          # the name the pane's outliner shows
frame_all()                                # camera + key light framing everything
export_glb("out/model.glb")                # FIRST: the 3D pane reloads now, in place
render("out/preview.png")                  # a still, seconds (engine="CYCLES", samples=64 for a beauty shot)
turntable("out/turntable.mp4", seconds=4)  # the pane's Turntable tab; the scene is left as it was
report()                                   # what the verdict reads
```

## What the pane shows, and how to feed it

### Shape Lab: authored controls, real geometry, kept directions

Expose choices that help the user explore **their** object. `parameters()` publishes controls to
`.harness/design.json` and reads the defaults or the user's `design-values.json` during each run:

```python
from harness_blender import parameters
p = parameters({
    "height": {"default": 260, "min": 180, "max": 380, "step": 5, "unit": "mm"},
    "ribs": {"type": "integer", "label": "Ribbons", "default": 24, "min": 12, "max": 48},
    "base": {"type": "boolean", "label": "Include base", "default": True},
    "finish": {"type": "choice", "default": "Ivory", "options": ["Ivory", "Terracotta"]},
}, title="Light, shaped by you", sources=["scenes", "assets"], output="out/model.glb")
# Use p["height"], p["ribs"], p["base"] and p["finish"] in the scene you author.
```

All controls need a `default`. Numeric controls default to type `number` and step `1`; they need
finite `min < max` bounds. Integer bounds and steps must be integers. Optional `label`,
`description` and `unit` explain a control. Support is bounded to 1–16 controls and 2–12 choice
options. A control ID uses lowercase letters, numbers and underscores, starting with a letter.

`sources` lists existing relative files or folders needed to rebuild: the entry script, local
imports and assets. By default it includes the entry script's folder and `assets/` when present.
List root-level imports or other asset folders explicitly. Hidden files, dependencies, output
folders and symlinks are not inputs. Use relative paths and the helper's workspace convention;
the native preview is a separate working directory, not a sandbox for arbitrary Python.

Shape Lab snapshots the declared files and runs the entry script with chosen values. It keeps
the last good preview while another builds, coalesces rapid changes, and stops a preview after
two minutes. `render()` and `turntable()` are skipped in this mode. Always produce the declared
`out/*.glb`/`.gltf` and `out/report.json`; prefer a self-contained GLB. Other dependencies must
already be available in the harness's Python environment.

**Keep** saves source, helper modules and their license, values, actual exports, measurements,
thumbnail, a rebuild script and a ZIP in `out/designs/<id>/`. Saved directions survive source
edits and viewer restarts. **Use values on next build** writes the chosen values to the project
only when the authored source still matches. It does not replace the current model, renders or
verdict; run the scene and verdict normally to produce that delivery. Preserve the user's values
when refining, and migrate them explicitly if the control schema changes.

For example, a user may keep a short wide cup and a tall handle-free tumbler, then ask you to
refine the tumbler's rim. Read its saved source and measurements instead of approximating it from
the thumbnail. Geometry, camera and finish remain ordinary editable Blender Python.

### Viewport metadata

The pane is a 3D viewport of the glTF, not a video player. `export_glb` carries everything it needs:

- **Names and hierarchy**: every renderable object under its Blender name, collections as the
  outliner's tree, parenting kept. Name objects, collections and materials for what they are.
- **Facts per object** (as glTF `extras`): dimensions and location in mm, rotation, scale, vertex /
  face / triangle counts, modifiers, materials, collections. Your own custom properties
  (`obj["part_no"] = "A-12"`) appear in the properties panel too.
- **Materials**: Principled BSDF base colour, metallic, roughness, textures; `diffuse_color` is what
  Solid shading uses — set it to match.
- **The scene camera and lights** (KHR_lights_punctual): the user can look through the camera
  (numpad 0) and switch the lights on in Material / Rendered shading.
- **Animation**: keyframed objects play on the pane's timeline (`obj.keyframe_insert(...)`,
  `scene.frame_end`, `scene.render.fps`).
- **Units**: the scene's unit scale travels with the export, so millimetres read as millimetres.

While a script runs, the helper writes `.harness/build.json` (step, turntable progress, failure) and
the pane shows "Rebuilding · …" over the last good model. Exports are written to a hidden file and
renamed into place, so the pane never reads half a file. Export after every meaningful change.

## Modelling, the parts that matter

- **Primitives**: `primitive_cube_add(size)`, `primitive_cylinder_add(vertices, radius, depth)`,
  `primitive_uv_sphere_add(radius)`, `primitive_torus_add(major_radius, minor_radius)`,
  `primitive_plane_add`. Each becomes `bpy.context.active_object`; name it.
- **Collections**: `c = bpy.data.collections.new("Lamp"); bpy.context.scene.collection.children.link(c)`,
  then move an object: `for u in list(o.users_collection): u.objects.unlink(o)` and `c.objects.link(o)`.
- **Modifiers** (non-destructive, applied on export): `o.modifiers.new("Bevel", "BEVEL")` (width,
  segments, `limit_method="ANGLE"`), `"SUBSURF"` (levels), `"BOOLEAN"` (operation DIFFERENCE/UNION,
  object — hide the cutter with `hide_render = True`), `"ARRAY"`, `"MIRROR"`, `"SOLIDIFY"`
  (thickness — a clean way to give an open shape a wall), `"SCREW"`, `"DISPLACE"`.
- **Smooth shading**: `bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))` on curved parts.
- **Edit-mode ops** when a modifier will not do: `bmesh` for exact geometry
  (`bmesh.ops.extrude_face_region`, `inset`, `bevel`, `delete`), then back to the mesh.
- **Curves and text**: `bpy.data.curves.new(type="FONT")` + `body` for lettering, `extrude` for depth.
- **Materials**: `bpy.data.materials.new`, `use_nodes = True`, Principled BSDF inputs `Base Color`,
  `Roughness`, `Metallic`; set `diffuse_color` too so Workbench and the pane's Solid mode show it.
- **Units**: `fresh()` puts the scene in millimetres. Model at real size; the report says the size.
- **Cameras**: `frame_all(azimuth, elevation)` for the shot; `render(engine="CYCLES")` for light,
  shadow and glass (CPU: 64 samples at 1280×720 is under a minute for a small scene).
- **Animation**: `obj.keyframe_insert("location", frame=n)`; `scene.frame_end`; it exports and plays
  on the pane's timeline.
- **Geometry Nodes** exist (`modifiers.new(type="NODES")`) but hand-built node trees are long; prefer
  modifiers and bmesh unless the request is procedural by nature.

## Rules

- Never write inside the package; `out/` holds everything produced, `scenes/` the scripts.
- First a blocky version (primitives, no bevels), **export it**, then render; then refine and export
  again. The live 3D scene is the proof; the turntable is the deliverable.
- Deliver `out/model.glb` (and `.stl` when it is for printing); say the size in mm.
