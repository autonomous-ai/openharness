"""The starter: a parameterized mug — an open cylinder with Solidify, rim bevelled, a torus
handle, a ceramic material — exported as glTF (the pane shows it the moment it lands), previewed and
turned. Replace it."""
import math
import bpy
import bmesh
from harness_blender import export_glb, frame_all, fresh, parameters, render, report, turntable

p = parameters({
    "height": {"label": "Height", "default": 100, "min": 70, "max": 165, "step": 1, "unit": "mm"},
    "diameter": {"label": "Cup diameter", "default": 90, "min": 65, "max": 125, "step": 1, "unit": "mm"},
    "wall": {"label": "Wall", "default": 4, "min": 2, "max": 8, "step": 0.5, "unit": "mm"},
    "handle_radius": {"label": "Handle radius", "default": 22, "min": 16, "max": 28, "step": 1, "unit": "mm"},
    "handle": {"type": "boolean", "label": "Include handle", "default": True},
    "glaze": {"type": "choice", "label": "Glaze", "default": "Honey", "options": ["Honey", "Sea green", "Chalk", "Graphite"]},
    "roughness": {"label": "Surface roughness", "default": 0.35, "min": 0.08, "max": 0.9, "step": 0.01},
}, title="A cup, your way")

fresh()
# body: chosen diameter and height, with its top face removed and a wall added inward
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=p["diameter"] / 2, depth=p["height"], location=(0, 0, p["height"] / 2))
body = bpy.context.active_object
body.name = "Mug"
bm = bmesh.new()
bm.from_mesh(body.data)
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z > 0.9], context="FACES")
bm.to_mesh(body.data)
bm.free()
wall = body.modifiers.new("Wall", "SOLIDIFY")
wall.thickness = p["wall"]
wall.offset = -1
wall.use_even_offset = True
bevel = body.modifiers.new("Bevel", "BEVEL")
bevel.width = 1.2
bevel.segments = 3
bevel.limit_method = "ANGLE"
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
# handle: a torus, half sunk into the wall
handle = None
if p["handle"]:
    bpy.ops.mesh.primitive_torus_add(major_radius=p["handle_radius"], minor_radius=6, major_segments=64, minor_segments=24, location=(p["diameter"] / 2 + 7, 0, p["height"] / 2), rotation=(math.pi / 2, 0, 0))
    handle = bpy.context.active_object
    handle.name = "Handle"
    bpy.ops.object.shade_smooth()
# one material, a warm ceramic
mat = bpy.data.materials.new("Ceramic")
mat.use_nodes = True
color = {"Honey": (0.86, 0.58, 0.32, 1), "Sea green": (0.13, 0.42, 0.34, 1),
         "Chalk": (0.88, 0.87, 0.81, 1), "Graphite": (0.055, 0.07, 0.085, 1)}[p["glaze"]]
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = color
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = p["roughness"]
mat.diffuse_color = color
mat.roughness = p["roughness"]
for o in [body] + ([handle] if handle else []):
    o.data.materials.append(mat)

frame_all()
export_glb("out/model.glb")                # first: the 3D pane updates in a second
render("out/preview.png")
turntable("out/turntable.mp4", seconds=4)
report()
