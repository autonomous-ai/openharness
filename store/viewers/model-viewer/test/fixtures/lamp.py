"""An independently authored scene for the Shape Lab native integration check.

The viewer knows none of these controls or shapes. A JSON asset supplies its finishes.
"""
import json
import math
from pathlib import Path
import bpy
from harness_blender import fresh, parameters, frame_all, export_glb, report

p = parameters({
    "height": {"default": 260, "min": 180, "max": 380, "step": 5, "unit": "mm"},
    "diameter": {"default": 130, "min": 90, "max": 180, "step": 5, "unit": "mm"},
    "ribs": {"type": "integer", "label": "Ribbons", "default": 24, "min": 12, "max": 48, "step": 1},
    "twist": {"default": 35, "min": -75, "max": 75, "step": 1, "unit": "°"},
    "finish": {"type": "choice", "default": "Ivory", "options": ["Ivory", "Terracotta", "Ocean"]},
}, title="Light, shaped by you", sources=["scenes", "assets"])
fresh()
colors = json.loads(Path("assets/finishes.json").read_text())
material = bpy.data.materials.new(p["finish"])
material.diffuse_color = (*colors[p["finish"]], 1)
material.roughness = 0.48
material.use_nodes = True
shader = material.node_tree.nodes["Principled BSDF"]
shader.inputs["Base Color"].default_value = material.diffuse_color
shader.inputs["Roughness"].default_value = material.roughness
for rib in range(p["ribs"]):
    vertices, faces = [], []
    for level in range(33):
        t = level / 32
        radius = p["diameter"] / 2 * (0.78 + 0.22 * math.cos(2 * math.pi * t))
        angle = 2 * math.pi * rib / p["ribs"] + math.radians(p["twist"]) * (t - 0.5)
        for side in (-1, 1):
            a = angle + side * math.pi / p["ribs"] * 0.56
            vertices.append((radius * math.cos(a), radius * math.sin(a), 8 + p["height"] * t))
        if level:
            k = level * 2
            faces.append((k - 2, k - 1, k + 1, k))
    mesh = bpy.data.meshes.new(f"Ribbon {rib + 1}")
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(mesh.name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    wall = obj.modifiers.new("Ribbon thickness", "SOLIDIFY")
    wall.thickness = 1.5
    wall.offset = 0
    for polygon in mesh.polygons:
        polygon.use_smooth = True
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=p["diameter"] * 0.52, depth=8, location=(0, 0, 4))
base = bpy.context.object
base.name = "Foot"
base.data.materials.append(material)
bevel = base.modifiers.new("Soft edge", "BEVEL")
bevel.width = 1.4
bevel.segments = 3
frame_all(azimuth=38, elevation=18)
export_glb("out/model.glb")
report()
