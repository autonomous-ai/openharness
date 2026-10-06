#!/usr/bin/env python3
"""Bake the init collection into reusable cropped RGB565/alpha layers.

Host code draws geometry. Firmware only selects cached bitmaps and shared poses.
Tim's original full-frame generator remains the round artwork source.
"""
from pathlib import Path
import hashlib, json, math, re, zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import daemon_art as art
from generate_art import landscape, encode

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'generated'
PREVIEWS=OUT/'daemons'
REPO=ROOT.parents[3]
SIZES=(350,160)
MOODS=('idle','working','attention','done','offline','asleep','booped','listening')
EXPRESSIONS=('idle','blink','working','attention','done','offline','asleep','booped')
EMOTIONS=('warm','happy','excited','gentle','sad','thoughtful','curious','angry')
MOTION_FRAMES=8
ROLES=('background','rear','body','front','face','letter')
SCENES=('meadow','shore','dusk','paper')

def scene(key):
    if key=='meadow':
        return landscape()
    scale=3
    palettes={'shore':('#e2edf0','#c2dada','#97bcc0'),
              'dusk':('#e7dfef','#cbbbd9','#aea2c3'),
              'paper':('#f2f0e9','#e8e5db','#dfdbd1')}
    sky,back,front=palettes[key]
    im=Image.new('RGB',(720*scale,720*scale),sky);d=ImageDraw.Draw(im)
    def poly(points,fill): d.polygon([(int(x*scale),int(y*scale)) for x,y in points],fill=fill)
    if key=='shore':
        d.ellipse((520*scale,133*scale,612*scale,225*scale),fill='#fff1ca')
        poly([(0,410),(140,420),(320,403),(530,415),(720,400),(720,720),(0,720)],back)
        poly([(0,505),(160,477),(385,495),(605,470),(720,490),(720,720),(0,720)],front)
        d.arc((398*scale,445*scale,530*scale,467*scale),10,170,fill='#e5eeee',width=2*scale)
    elif key=='dusk':
        d.ellipse((523*scale,144*scale,595*scale,216*scale),fill='#faf0db')
        poly([(0,403),(154,347),(360,392),(577,329),(720,390),(720,720),(0,720)],back)
        poly([(0,505),(193,451),(462,497),(646,458),(720,488),(720,720),(0,720)],front)
    else:
        d.ellipse((-80*scale,433*scale,811*scale,1180*scale),fill=back)
        d.ellipse((65*scale,530*scale,650*scale,672*scale),fill=front)
    return im.resize((720,720),Image.Resampling.LANCZOS)

def letter(size):
    s=3;im=Image.new('RGBA',(64*s,64*s));d=ImageDraw.Draw(im)
    d.rounded_rectangle((4*s,12*s,60*s,51*s),5*s,fill='#fff4d9',outline='#b49871',width=2*s)
    d.line([(7*s,16*s),(32*s,34*s),(57*s,16*s)],fill='#b49871',width=2*s,joint='curve')
    d.line([(7*s,48*s),(23*s,32*s)],fill='#d6bc97',width=s)
    d.line([(57*s,48*s),(41*s,32*s)],fill='#d6bc97',width=s)
    return im.resize((size,size),Image.Resampling.LANCZOS)

def main():
    PREVIEWS.mkdir(parents=True,exist_ok=True)
    roster=json.loads((REPO/'daemons/roster.json').read_text())
    expected=tuple(d['id'] for d in roster['daemons'] if d['drop']=='init')
    assert tuple(art.IDS)==expected and len(expected)==10, 'Artwork must cover exactly init'
    registry=(REPO/'devices/harness-device/firmware/main/ui/habitat/pro_daemons.def').read_text()
    assert tuple(re.findall(r'PRO_DAEMON\(\w+,\s*"(\w+)"',registry))==expected
    blob=bytearray();memo={};bases={};blocks=[];capacities=[0]*len(ROLES)
    def asset(name,source,role,size=None,alpha=True):
        im=source.convert('RGBA')
        if size and im.size!=(size,size): im=im.resize((size,size),Image.Resampling.LANCZOS)
        x=y=0
        if alpha:
            box=im.getchannel('A').getbbox()
            if box:
                x=max(0,box[0]-1);y=max(0,box[1]-1)
                box=(x,y,min(im.width,box[2]+1),min(im.height,box[3]+1))
                im=im.crop(box)
            else: im=Image.new('RGBA',(1,1))
        raw=encode(im,alpha)
        digest=hashlib.sha256(raw).hexdigest()
        key=(im.width,im.height,alpha,digest)
        if key not in memo:
            data=zlib.compress(raw,9);base_offset=base_length=0
            base_key=(im.width,im.height,alpha,role,name.split('_')[0])
            references=bases.setdefault(base_key,[])
            # Keep a few independent anchors; never chain delta decodes.
            if '_speech_warm_0' not in name:
                for base in references:
                    delta=np.bitwise_xor(np.frombuffer(raw,dtype=np.uint8),
                                         np.frombuffer(base[0],dtype=np.uint8)).tobytes()
                    compressed=zlib.compress(delta,9)
                    if len(compressed)+8<len(data):
                        data=compressed;base_offset,base_length=base[1:]
            if not base_length and len(references)<6:
                references.append((raw,len(blob),len(data)))
            memo[key]=(len(blob),len(data),base_offset,base_length);blob.extend(data)
        off,n,base_offset,base_length=memo[key];r=ROLES.index(role)
        capacities[r]=max(capacities[r],len(raw)*2)
        b=dict(name=name,offset=off,length=n,raw_length=len(raw),width=im.width,height=im.height,
               x=x,y=y,alpha=int(alpha),role=r,base_offset=base_offset,base_length=base_length,sha256=digest)
        blocks.append(b)
        return b
    backgrounds=[asset('scene_'+key,scene(key),'background',alpha=False) for key in SCENES]
    for key in SCENES: scene(key).save(PREVIEWS/f'scene-{key}.png')
    daemons=[]
    for key in expected:
        print('Drawing '+key,flush=True)
        resting=art.render_layers(key)
        body=[asset(f'{key}_{size}_body',resting['body'],'body',size) for size in SIZES]
        motion={part:[[] for _ in SIZES] for part in ('rear','front')}
        for group in range(4):
            poses=[art.render_layers(key,pose=group*2+.5-.5*math.cos(math.tau*f/MOTION_FRAMES))
                   for f in range(MOTION_FRAMES)]
            for si,size in enumerate(SIZES):
                for part in motion:
                    motion[part][si].append([asset(f'{key}_{size}_{part}_{group}_{f}',p[part],part,size)
                                             for f,p in enumerate(poses)])
        faces=[];touch=[];speech=[]
        for size in SIZES:
            faces.append([asset(f'{key}_{size}_{expr}',art.render_layers(key,expression=expr)['face'],'face',size)
                          for expr in EXPRESSIONS])
            touch.append([asset(f'{key}_{size}_touch_{look}',art.render_layers(key,expression='idle',look=look)['face'],'face',size)
                          for look in range(-2,3)])
            speech.append([[asset(f'{key}_{size}_speech_{emotion}_{level}',
                              art.render_layers(key,expression='listening',level=level,emotion=emotion)['face'],'face',size)
                            for level in range(5)] for emotion in EMOTIONS])
        anchors=getattr(art,'LETTER_ANCHORS',{}).get(key,(276,238))
        daemons.append(dict(key=key,body=body,rear=motion['rear'],front=motion['front'],face=faces,
                            touch=touch,speech=speech,letter_anchor=[[round(v*sz/350) for v in anchors] for sz in SIZES]))
        # Full and small mood plates, showing the same registered layers as firmware.
        plate=Image.new('RGB',(4*350,2*390),'#f2f0e9');d=ImageDraw.Draw(plate)
        for i,mood in enumerate(MOODS):
            layers=art.render_layers(key,pose={'working':2.5,'attention':4.5,'done':6.5}.get(mood,.5),expression=mood,level=3)
            composed=Image.new('RGBA',(350,350))
            for part in ('rear','body','front','face'): composed.alpha_composite(layers[part])
            x=(i%4)*350;y=(i//4)*390;plate.paste(composed,(x,y),composed)
            d.text((x+16,y+356),mood,fill='#263b34')
            if mood=='idle': composed.save(PREVIEWS/f'{key}.png')
        plate.save(PREVIEWS/f'{key}-moods.png')
    letters=[asset(f'letter_{size}',letter(size),'letter') for size in (64,30)]
    def init(b):
        return '{'+','.join(str(b[k]) for k in ('offset','length','raw_length','width','height','x','y','alpha','role','base_offset','base_length'))+'}'
    def nested(value):
        if isinstance(value,dict): return init(value)
        if isinstance(value,int): return str(value)
        return '{'+','.join(nested(v) for v in value)+'}'
    h=['/* Generated by generate_daemons.py. Cropped zlib RGB565LE + alpha8 layers. */',
       '#pragma once','#include <stdint.h>',
       'typedef struct { uint32_t offset,length,raw_length; uint16_t width,height; int16_t x,y; uint8_t alpha,role; uint32_t base_offset,base_length; } pro_art_frame_t;',
       'enum { PRO_ART_HERO=0,PRO_ART_COMPACT=1,PRO_ART_SIZE_COUNT=2,PRO_ART_MOOD_COUNT=8,PRO_ART_FRAMES=24,',
       f'       PRO_ART_MOTION_FRAMES={MOTION_FRAMES},PRO_ART_ROLE_COUNT=6,PRO_ART_SCENE_COUNT=4,PRO_ART_DAEMON_COUNT=10 }};',
       'enum { PRO_ART_BACKGROUND,PRO_ART_REAR,PRO_ART_BODY,PRO_ART_FRONT,PRO_ART_FACE,PRO_ART_LETTER };',
       'static const uint16_t pro_art_sizes[2]={350,160};',
       'static const uint32_t pro_art_cache_bytes[6]={'+','.join(map(str,capacities))+'};',
       'typedef struct { pro_art_frame_t body[2],rear[2][4][PRO_ART_MOTION_FRAMES],front[2][4][PRO_ART_MOTION_FRAMES],',
       ' face[2][8],touch[2][5],speech[2][8][5]; int16_t letter_anchor[2][2]; } pro_art_daemon_t;',
       'static const pro_art_frame_t pro_art_scenes[4]='+nested(backgrounds)+';',
       'static const pro_art_frame_t pro_art_letter[2]='+nested(letters)+';',
       'static const pro_art_daemon_t pro_art_daemons[PRO_ART_DAEMON_COUNT]={']
    for daemon in daemons:
        h.append('{ /* '+daemon['key']+' */')
        h.extend('.'+k+'='+nested(daemon[k])+',' for k in ('body','rear','front','face','touch','speech','letter_anchor'))
        h.append('},')
    digest=hashlib.sha256(blob).hexdigest()
    h.extend(['};',f'#define PRO_ART_PACK_BYTES {len(blob)}u',f'#define PRO_ART_PACK_SHA256 "{digest}"',''])
    (OUT/'pro_art.h').write_text('\n'.join(h));(OUT/'pro_art.pack').write_bytes(blob)
    manifest=dict(format='cropped zlib RGB565LE + alpha8 layers',daemons=list(expected),scenes=list(SCENES),
                  sizes=list(SIZES),moods=list(MOODS),frames=24,motion_frames=MOTION_FRAMES,roles=list(ROLES),
                  cache_bytes=capacities,working_set_bytes=sum(capacities),bytes=len(blob),sha256=digest,
                  unique_blocks=len(memo),blocks=blocks,
                  source_sha256={str(p.relative_to(REPO)):hashlib.sha256(p.read_bytes()).hexdigest()
                                 for p in (Path(__file__),Path(art.__file__),REPO/'daemons/roster.json')})
    (OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    for b in blocks:
        raw=zlib.decompress(blob[b['offset']:b['offset']+b['length']])
        if b['base_length']:
            base=zlib.decompress(blob[b['base_offset']:b['base_offset']+b['base_length']])
            raw=bytes(a^c for a,c in zip(raw,base))
        assert len(raw)==b['raw_length'] and hashlib.sha256(raw).hexdigest()==b['sha256']
        expected_bytes=b['width']*b['height']*(3 if b['alpha'] else 2)
        assert len(raw)==expected_bytes and len(raw)<=capacities[b['role']]
    assert len(blob)<6*1024*1024, f'Art exceeds6MiB: {len(blob)}'
    print(json.dumps({k:v for k,v in manifest.items() if k not in ('blocks','source_sha256')},indent=2))

if __name__=='__main__': main()
