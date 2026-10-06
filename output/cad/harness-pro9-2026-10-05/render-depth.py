"""Orthographic CAD preview with per-pixel depth; illustrative component colors."""
from pathlib import Path
import struct
import numpy as np
from PIL import Image, ImageDraw, ImageFont

folder = Path(__file__).parent
triangles, colors, normals = [], [], []
for index in range(10):
    raw = (folder / f'part-{index:02}.stl').read_bytes()
    count = struct.unpack_from('<I', raw, 80)[0]
    records = np.frombuffer(raw, dtype=np.dtype([
        ('normal', '<f4', (3,)), ('vertices', '<f4', (3, 3)), ('attribute', '<u2')
    ]), count=count, offset=84)
    triangles.extend(records['vertices'])
    normals.extend(records['normal'])
    color = (218, 215, 205) if index == 8 else (39, 46, 49) if index in (6, 7) else (164, 127, 68)
    colors.extend([color] * count)
triangles = np.asarray(triangles, dtype=float) - np.array([0, 4, 25])
normals, colors = np.asarray(normals, dtype=float), np.asarray(colors, dtype=float)
light = np.array([-0.35, -0.45, 0.82]); light /= np.linalg.norm(light)
colors *= (0.58 + 0.42 * np.maximum(normals @ light, 0))[:, None]

def render(elevation, azimuth):
    width, height, scale = 900, 620, 7.3
    el, az = np.radians([elevation, azimuth])
    direction = np.array([np.cos(el)*np.cos(az), np.cos(el)*np.sin(az), np.sin(el)])
    right = np.array([-np.sin(az), np.cos(az), 0])
    up = np.cross(direction, right)
    projected = np.stack([triangles @ right, -(triangles @ up), triangles @ direction], axis=-1)
    projected[:, :, :2] *= scale
    projected[:, :, 0] += width / 2
    projected[:, :, 1] += height / 2
    pixels = np.full((height, width, 3), [246, 245, 241], dtype=np.uint8)
    depth = np.full((height, width), -np.inf)
    for points, color in zip(projected, colors):
        x0, y0, z0 = points[0]; x1, y1, z1 = points[1]; x2, y2, z2 = points[2]
        den = (y1-y2)*(x0-x2) + (x2-x1)*(y0-y2)
        if abs(den) < 1e-10: continue
        xmin = max(0, int(np.ceil(min(x0,x1,x2)-0.5))); xmax = min(width-1, int(np.floor(max(x0,x1,x2)-0.5)))
        ymin = max(0, int(np.ceil(min(y0,y1,y2)-0.5))); ymax = min(height-1, int(np.floor(max(y0,y1,y2)-0.5)))
        if xmax < xmin or ymax < ymin: continue
        yy, xx = np.mgrid[ymin:ymax+1, xmin:xmax+1]; xx = xx+0.5; yy = yy+0.5
        a = ((y1-y2)*(xx-x2)+(x2-x1)*(yy-y2))/den
        b = ((y2-y0)*(xx-x2)+(x0-x2)*(yy-y2))/den
        c = 1-a-b
        z = a*z0+b*z1+c*z2
        target_depth = depth[ymin:ymax+1, xmin:xmax+1]
        mask = (a>=-1e-7)&(b>=-1e-7)&(c>=-1e-7)&(z>target_depth)
        target_depth[mask] = z[mask]
        pixels[ymin:ymax+1, xmin:xmax+1][mask] = color.astype(np.uint8)
    return Image.fromarray(pixels)

canvas = Image.new('RGB', (1900, 1530), (246,245,241))
draw = ImageDraw.Draw(canvas)
fontfile = '/System/Library/Fonts/Supplemental/Arial.ttf'
font = lambda size: ImageFont.truetype(fontfile, size)
draw.text((65,35), 'HARNESS PRO  /  FINAL INDUSTRIAL DESIGN', fill='#26312d', font=font(37))
draw.text((65,92), 'Harness_pro9.step  |  5 October 2026  |  Actual CAD geometry', fill='#626a65', font=font(24))
for title, el, az, x, y in [
    ('FRONT THREE QUARTER', 28,-65, 35,185),
    ('REAR THREE QUARTER', 28,115, 965,185),
    ('SIDE PROFILE', 0,0, 35,820),
    ('TOP VIEW', 90,-90, 965,820),
]:
    print(title, flush=True)
    canvas.paste(render(el,az),(x,y))
    draw.text((x+30,y-25),title,fill='#626a65',font=font(21))
draw.text((65,1430),'87.37 × 83.17 × 26.22 mm overall  |  15° display tilt  |  10 solids',fill='#26312d',font=font(25))
draw.text((65,1480),'Inspection colors only; materials and finish are not specified by this preview.',fill='#626a65',font=font(21))
canvas.save(folder/'cad-inspection.png')
print(folder/'cad-inspection.png',flush=True)
