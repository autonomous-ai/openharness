"""Shared growth, material masks and species motion for desktop and round dial.

Only the authored coat colours are recoloured. Eyes, cheeks, horns, accessories
and antialiased silhouettes remain registered to the approved illustrations.
The two material channels are weighted shade and coat coverage. Four additional
channels hold the species' four named markings, in roster order.
"""
from functools import lru_cache
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw
import daemon_art as art

ROOT = Path(__file__).resolve().parents[3]
ROSTER = {d['id']: d for d in json.loads((ROOT/'daemons/roster.json').read_text())['daemons']}
AGES = {'baby': (.62, .80, .60), 'young': (.82, .85, .75), 'adult': (1., 1., 1.)}
COATS = {
 'tim': '9974af a381bc b296c6 78558e 624778 b592b4',
 'gnu': '656955 747b66 8c9276 9ca386 adb293 a5ab8a bec19f cacbad 8b9478',
 'lynx': '799675 91aa84 8eaa81 a2b992 748e6d 6b8668 8caa80 465e52 7e9b78 40594d aabc95 869778 a0b98d',
 'mutt': 'b77652 c98e64 d5a176 cf966c ab6d47 8f593f a66a46 bd8460 c98d63',
 'yak': '68504b 90675a a87c69 b68d76 895f52 a57966 966c5d 825c50 825c51 a57a66 69534c',
 'gopher': 'b28b51 bb9157 c69b60 d9b171 d8af75 c99f68 b88f54 a38153 a58c65',
 'bug': '8c8b68 b8b592 9a9875 bbb99c d0cdb0 d7d3b7 99977b 85876c b0af88 7b7b67 afa480 817c65 a49e7b 73765b',
 'tux': '3e4f83 354675 40548d 4c619a 687cae 344575 4e649d',
 'auk': '3e514e 305a67 547984 31515b 244a56 8fa9a8 9caaa0',
 'beastie': 'be675e cd7569 e6a18c d77b6e e0917e edac94 cf7569 bd665f c36b62 d37a6d e0937f',
}
# Frame milliseconds (idle, work, attention, done, fail, sleep, boop, voice),
# horizontal sway, completion hop and boop squash. Source geometry already
# gives each species its own appendage movement; these make its cadence distinct.
PERSONALITY = {
 'tim': ([210,140,160,110,0,390,130,100], 0,5,2),
 'gnu': ([260,190,180,150,0,460,170,100], 1,3,1),
 'lynx': ([220,120,135,100,0,420,100,100], 1,6,1),
 'mutt': ([160,110,120,90,0,350,100,100], 2,7,3),
 'yak': ([330,240,230,190,0,520,210,100], 1,2,1),
 'gopher': ([180,130,140,95,0,360,110,100], 0,8,3),
 'bug': ([170,100,110,85,0,320,90,100], 1,4,2),
 'tux': ([230,160,160,120,0,430,150,100], 3,4,2),
 'auk': ([280,190,190,150,0,470,180,100], 2,3,1),
 'beastie': ([150,100,110,80,0,340,90,100], 2,9,3),
}

def rgb(value):
    value = value.lstrip('#')
    return tuple(int(value[i:i+2],16) for i in (0,2,4))

def palettes(species):
    # Keep the roster's named family, softened to the existing illustration.
    return [([round(v*.80+25) for v in rgb(row[3])],
             [round(v*.80+44) for v in rgb(row[2])])
            for row in ROSTER[species]['traits']['colours']]

@lru_cache(maxsize=50)
def marking(species, name):
    c=art.Canvas(); white='#ffffff'
    if name in ('spots','freckles','speckles'):
        r=8 if name=='spots' else 3.5
        for x,y in ((101,99),(136,77),(183,88),(226,106),(108,203),(227,219),(155,257),(204,275)):
            c.ellipse((x-r,y-r*.75,x+r,y+r*.75),white)
    elif name in ('stripes','brindle','barred','lined','bands','ringed','ringtail','grooved'):
        for y in range(77,314,30 if name not in ('lined','grooved') else 18):
            c.line([(65,y+12),(130,y),(205,y+9),(294,y-6)],white,5 if name in ('lined','grooved') else 10)
    elif name in ('blaze','bib','goatee'):
        if name=='blaze': c.polygon([(166,55),(182,55),(188,130),(176,191),(163,135)],white)
        elif name=='bib': c.ellipse((131,211,219,286),white)
        else: c.polygon([(155,211),(194,211),(175,247)],white)
    elif name in ('socks','mittens','tips','winter','two-tone'):
        c.roundrect((40,253 if name!='two-tone' else 215,317,322),8,white)
    elif name in ('patches','piebald'):
        c.ellipse((76,82,150,128),white); c.ellipse((199,216,256,265),white)
    elif name=='eyespots':
        for x in (135,214):
            c.ellipse((x-18,227,x+18,260),white);c.ellipse((x-7,236,x+7,250),'#000000')
    elif name in ('chinstrap','bridled','mask','cheeks'):
        y=189 if name=='chinstrap' else 149
        if name=='cheeks':
            c.ellipse((110,175,134,190),white); c.ellipse((211,175,235,190),white)
        else: c.curve((83,y-15),(127,y+23),(223,y+23),(273,y-15),white,9)
    elif name=='crest': c.polygon([(156,44),(171,26),(176,49),(191,30),(196,72),(156,72)],white)
    else: raise ValueError((species,name))
    return c.finish().getchannel('R')

def materials(species, layer, role):
    """Six scalar planes, with original alpha so occlusion stays exact."""
    rgba=np.asarray(layer); pixels=rgba[:,:,:3].astype(np.int32)
    coat=np.array([rgb(c) for c in COATS[species].split()],dtype=np.int32)
    distance=np.full(rgba.shape[:2],2**30,dtype=np.int32); shade=np.zeros_like(distance)
    lights=coat@np.array([54,183,19])//256
    lo,hi=int(lights.min()),int(lights.max())
    if role!='face':
        for color,luma in zip(coat,lights):
            d=np.sum((pixels-color)**2,axis=2); take=d<distance
            shade[take]=32+(int(luma)-lo)*207//max(1,hi-lo);distance=np.minimum(distance,d)
    weight=np.where(distance<600,255,0).astype(np.uint8)
    planes=[Image.fromarray((shade*weight//255).astype(np.uint8)),Image.fromarray(weight)]
    for name,_ in ROSTER[species]['traits']['marks'][1:]:
        planes.append(ImageChops.multiply(marking(species,name),planes[1]))
    return [Image.merge('RGBA',(p,p,p,layer.getchannel('A'))) for p in planes]

@lru_cache(maxsize=16)
def material_layers(species, pose, expression, look=0, level=0):
    source=art.render_layers(species,pose=pose,expression=expression,look=look,level=level)
    planes={role:materials(species,layer,role) for role,layer in source.items()}
    return [{role:layers[i] for role,layers in planes.items()} for i in range(6)]

def styled(image, material, marks, palette, mark):
    """Reference implementation of the small integer shader on both clients."""
    pixels=np.array(image,dtype=np.int32); m=np.asarray(material,dtype=np.int32)
    shade,weight=m[:,:,0],m[:,:,1]
    if palette is not None:
        dark,light=palette
        for ch in range(3):
            pixels[:,:,ch]=(pixels[:,:,ch]*(255-weight)+dark[ch]*weight+(light[ch]-dark[ch])*shade+127)//255
    if mark:
        a=(m[:,:,2] if mark==1 else np.asarray(marks,dtype=np.int32)[:,:,mark-2])*100//255
        # A darker coat marking, not a face paint or replacement silhouette.
        for ch in range(3): pixels[:,:,ch]=pixels[:,:,ch]*(255-a)//255
    return Image.fromarray(np.clip(pixels,0,255).astype(np.uint8))
