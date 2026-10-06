"""Render the supplied Pro CAD meshes with a proposed screen, without changing geometry.

python render-hardware.py path/to/STEP-derived-STLs
STLs are in millimetres, named part-00.stl ... part-09.stl. These are not print files.
The website serves the checked-in WebP files and does not require this renderer.
"""
from pathlib import Path
import sys
import struct
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/pro'
MESHES = Path(sys.argv[1])
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
def font(size, bold=False):
    try: return ImageFont.truetype(BOLD if bold else FONT, size)
    except OSError: return ImageFont.load_default(size=size)

screen = Image.new('RGB', (720,720), '#f5f4ef')
d = ImageDraw.Draw(screen)
# Code-native display study on the unchanged, STEP-derived enclosure.
def centered(text, y, size, color, bold=False, x=360):
    d.text((x,y), text, font=font(size,bold), fill=color, anchor='mm')
d.text((48,48), 'Launch', font=font(29), fill='#383331')
d.line([(153,63),(159,69),(165,63)], fill='#827c73', width=2)
for x in (646,655,664): d.ellipse((x,60,x+3,63),fill='#49423e')
centered('Claude Code  ·  MacBook',132,22,'#827b73')
pet=Image.open(OUT/'tim_adult_idle_0.png').convert('RGBA')
pet.thumbnail((285,285))
screen.paste(pet,((720-pet.width)//2,188),pet)
centered('Build the launch',488,37,'#36312f')
centered('Working  ·  4:12',533,22,'#827b73')
centered('Tap to speak',588,21,'#91897f')
d.line((42,630,678,630),fill='#ded8ce',width=1)
d.ellipse((46,655,82,691),fill='#e7ddd0')
centered('2',675,22,'#88724f',x=64)
d.text((94,662), 'need you', font=font(21), fill='#84796b')
d.ellipse((220,655,256,691),fill='#e6dfee')
centered('1',675,22,'#857193',x=238)
d.text((268,662), 'ready', font=font(21), fill='#84796b')
centered('Today · MacBook',657,17,'#999085',x=600)
centered('~$3.42+',687,28,'#675d55',x=607)
texture=np.asarray(screen)
screen.save(OUT/'screen-preview.webp',quality=92)

triangles=[];normals=[];colors=[];indices=[]
for index in range(10):
    raw=(MESHES/f'part-{index:02}.stl').read_bytes()
    count=struct.unpack_from('<I',raw,80)[0]
    rec=np.frombuffer(raw,dtype=np.dtype([('normal','<f4',(3,)),('vertices','<f4',(3,3)),('attribute','<u2')]),count=count,offset=84)
    triangles.extend(rec['vertices']);normals.extend(rec['normal']);indices.extend([index]*count)
    color=(232,229,218) if index==8 else (23,28,27) if index in (6,7) else (192,188,175)
    colors.extend([color]*count)
vertices=np.asarray(triangles,dtype=float)
normals=np.asarray(normals,dtype=float);colors=np.asarray(colors,dtype=float)
light=np.array([-0.3,-0.4,0.85]);light/=np.linalg.norm(light)
colors*=(0.68+0.32*np.maximum(normals@light,0))[:,None]
center=np.array([0,5.22077381299,27.97893916208])
screen_up=np.array([0,0.9659408771,0.2587628681])
uv=np.stack([0.5+(vertices[:,:,0]-center[0])/71.93278,0.5-((vertices-center)@screen_up)/71.93278],axis=-1)
is_screen=(np.asarray(indices)==6)&((normals@np.array([0,-0.2587628681,0.9659408771]))>0.99)

def render(name,elevation,azimuth,scale=10.2,width=1320,height=1020,textured=True):
    output_size = (width, height)
    width *= 2; height *= 2; scale *= 2
    el,az=np.radians([elevation,azimuth])
    direction=np.array([np.cos(el)*np.cos(az),np.cos(el)*np.sin(az),np.sin(el)])
    right=np.array([-np.sin(az),np.cos(az),0]);up=np.cross(direction,right)
    tri=vertices-np.array([0,4,25])
    points=np.stack([tri@right,-(tri@up),tri@direction],axis=-1)
    points[:,:,:2]*=scale;points[:,:,0]+=width/2;points[:,:,1]+=height/2
    pixels=np.zeros((height,width,4),dtype=np.uint8);depth=np.full((height,width),-np.inf)
    for p,color,tex,tex_uv in zip(points,colors,is_screen,uv):
        x0,y0,z0=p[0];x1,y1,z1=p[1];x2,y2,z2=p[2]
        den=(y1-y2)*(x0-x2)+(x2-x1)*(y0-y2)
        if abs(den)<1e-10:continue
        xmin=max(0,int(np.ceil(min(x0,x1,x2)-.5)));xmax=min(width-1,int(np.floor(max(x0,x1,x2)-.5)))
        ymin=max(0,int(np.ceil(min(y0,y1,y2)-.5)));ymax=min(height-1,int(np.floor(max(y0,y1,y2)-.5)))
        if xmax<xmin or ymax<ymin:continue
        yy,xx=np.mgrid[ymin:ymax+1,xmin:xmax+1];xx=xx+.5;yy=yy+.5
        a=((y1-y2)*(xx-x2)+(x2-x1)*(yy-y2))/den;b=((y2-y0)*(xx-x2)+(x0-x2)*(yy-y2))/den;c=1-a-b
        z=a*z0+b*z1+c*z2;target_depth=depth[ymin:ymax+1,xmin:xmax+1]
        mask=(a>=-1e-7)&(b>=-1e-7)&(c>=-1e-7)&(z>target_depth)
        if not mask.any():continue
        target_depth[mask]=z[mask];target=pixels[ymin:ymax+1,xmin:xmax+1];target[mask]=[*color.astype(np.uint8),255]
        if textured and tex:
            u=a*tex_uv[0,0]+b*tex_uv[1,0]+c*tex_uv[2,0];v=a*tex_uv[0,1]+b*tex_uv[1,1]+c*tex_uv[2,1]
            tmask=mask&(u>=0)&(u<=1)&(v>=0)&(v<=1)
            target[tmask,:3]=texture[np.clip((v[tmask]*719).astype(int),0,719),np.clip((u[tmask]*719).astype(int),0,719)]
    Image.fromarray(pixels).resize(output_size, getattr(Image, 'Resampling', Image).LANCZOS).save(OUT/name,quality=95,method=6)
    print(name,flush=True)

render('harness-pro-hero.webp',40,-66)
render('harness-pro-rear.webp',24,116,scale=10.5,textured=False)
render('harness-pro-side.webp',0,0,scale=11,width=1200,height=440,textured=False)
