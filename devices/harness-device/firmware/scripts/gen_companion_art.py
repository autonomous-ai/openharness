#!/usr/bin/env python3
"""Pack the desktop's ten approved illustrations for the round dial.

Five bounded, independently decoded layers keep animation small: rear, body,
front, expression and held mail. No runtime drawing or desktop assets on USB.
"""
from pathlib import Path
import hashlib
import importlib.util
import json
import zlib
import sys
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[4]
SOURCE = ROOT / 'daemons/tools/illustrated/daemon_art.py'
OUT = Path(__file__).resolve().parents[1] / 'assets/companions'
sys.path.insert(0, str(SOURCE.parent))
import appearance
import generate as desktop_art
spec = importlib.util.spec_from_file_location('daemon_art', SOURCE)
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)
SIZES = (240, 108)
ROLES = ('rear', 'body', 'front', 'face', 'letter')
blob, memo, blocks = bytearray(), {}, []
capacities = [0] * len(ROLES)


def asset(image, size, role, planes=None):
    image = image.resize((size, size), Image.Resampling.LANCZOS)
    box = image.getchannel('A').getbbox() or (0, 0, 1, 1)
    image = image.crop(box)
    pixels = list(image.get_flattened_data())
    # CO5300 panel order: high byte first, then one straight alpha plane.
    rgb = [((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3) for r, g, b, a in pixels]
    raw = b''.join(p.to_bytes(2, 'big') for p in rgb) + bytes(p[3] for p in pixels)
    for plane in planes or [Image.new('L',(350,350))]*6:
        raw += plane.resize((size,size),Image.Resampling.LANCZOS).crop(box).tobytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest not in memo:
        packed = zlib.compress(raw, 9)
        memo[digest] = (len(blob), len(packed))
        blob.extend(packed)
    offset, length = memo[digest]
    capacities[role] = max(capacities[role], len(raw))
    row = (offset, length, image.width, image.height, box[0], box[1], role)
    blocks.append(dict(offset=offset, length=length, raw=len(raw), sha256=digest))
    return row


def envelope():
    image = Image.new('RGBA', (192, 192))
    d = ImageDraw.Draw(image)
    d.rounded_rectangle((12, 33, 180, 147), 15, '#fff0cb', '#b79b69', 6)
    d.line([(21, 45), (96, 96), (171, 45)], '#b79b69', 6, joint='curve')
    d.line([(21, 138), (69, 93)], '#d2b785', 3)
    d.line([(171, 138), (123, 93)], '#d2b785', 3)
    return image


def c_array(name, dimensions, rows):
    def encode(value):
        return '{' + ','.join(str(v) if isinstance(v, int) else encode(v) for v in value) + '}'
    return f'static const companion_asset_t {name}{dimensions} = ' + encode(rows) + ';'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    bodies, parts, faces, letters, anchors = [], [], [], [], []
    # Growth artwork shares a floor for hatching on desktop. On the dial each
    # stage instead occupies the adult's visual centre. Use one idle anchor per
    # stage, never a moving frame's bounds, so gestures retain their motion.
    centres = {}
    for daemon in art.IDS:
        for stage in appearance.AGES:
            box = desktop_art.render_daemon(daemon, stage, 'idle', 0).getchannel('A').getbbox()
            centres[daemon, stage] = ((box[0]+box[2])/2, (box[1]+box[3])/2)
    growth_offsets = [
        [[[round((centres[d, 'adult'][axis]-centres[d, stage][axis])*size/350)
           for axis in range(2)] for d in art.IDS] for size in SIZES]
        for stage in appearance.AGES]
    def packed_layer(daemon, stage, role_name, size, role, pose=0, expression='idle', look=0, level=0):
        layers=art.render_layers(daemon,pose=pose,expression=expression,look=look,level=level)
        image=layers[role_name]
        planes=appearance.materials(daemon,image,role_name)
        # Decode one adult layer per species; resize only the active layer
        # in bounded PSRAM caches. All three stages share these flash blocks.
        return asset(image,size,role,[p.getchannel('R') for p in planes])
    for stage in appearance.AGES:
        stage_bodies,stage_parts,stage_faces,stage_anchors=[],[],[],[]
        for size in SIZES:
            body_rows, part_rows, face_rows, anchor_rows = [], [], [], []
            for daemon in art.IDS:
                body_rows.append(packed_layer(daemon,stage,'body',size,1))
                groups=[]
                for group in range(4):
                    phases=[]
                    for fraction in (0,.5,1,.5):
                        phases.append([packed_layer(daemon,stage,'rear',size,0,pose=group*2+fraction),
                                       packed_layer(daemon,stage,'front',size,2,pose=group*2+fraction)])
                    groups.append(phases)
                part_rows.append(groups)
                expressions=[]
                for expression in art.EXPRESSIONS:
                    expressions.append([packed_layer(daemon,stage,'face',size,3,expression=expression,
                        look=0 if expression=='listening' else variant-2,
                        level=variant if expression=='listening' else 0) for variant in range(5)])
                face_rows.append(expressions)
                scale=appearance.AGES[stage][0]
                x,y=art.LETTER_ANCHORS[daemon]
                anchor_rows.append([round((170+(x-170)*scale)*size/350),round((315+(y-315)*scale)*size/350)])
            stage_bodies.append(body_rows); stage_parts.append(part_rows)
            stage_faces.append(face_rows); stage_anchors.append(anchor_rows)
        bodies.append(stage_bodies); parts.append(stage_parts)
        faces.append(stage_faces); anchors.append(stage_anchors)
    for size in SIZES: letters.append(asset(envelope(),round(64*size/art.SIZE),4))
    header = ['/* Generated by scripts/gen_companion_art.py; do not edit. */', '#pragma once',
        '#include <stdint.h>',
        'typedef struct { uint32_t offset, length; uint16_t width, height; int16_t x, y; uint8_t role; } companion_asset_t;',
        'enum { COMPANION_COUNT=10, COMPANION_ROLES=5, COMPANION_FRAMES=24 };',
        'static const uint32_t companion_capacity[5] = {' + ','.join(map(str, capacities)) + '};',
        'static const uint16_t companion_duration[8] = {150,90,140,55,180,220,35,125};',
        c_array('companion_bodies', '[3][2][10]', bodies),
        c_array('companion_parts', '[3][2][10][4][4][2]', parts),
        c_array('companion_faces', '[3][2][10][9][5]', faces),
        c_array('companion_letters', '[2]', letters),
        'static const int16_t companion_letter_anchor[3][2][10][2] = ' +
            str(anchors).replace('[', '{').replace(']', '}') + ';',
        'static const int16_t companion_growth_offset[3][2][10][2] = ' +
            str(growth_offsets).replace('[', '{').replace(']', '}') + ';']
    header += ['static const uint8_t companion_palettes[10][6][2][3] = ' + str([appearance.palettes(d) for d in art.IDS]).replace('[','{').replace(']','}').replace('(','{').replace(')','}') + ';',
               'static const uint16_t companion_timing[10][8] = ' + str([appearance.PERSONALITY[d][0] for d in art.IDS]).replace('[','{').replace(']','}').replace('(','{').replace(')','}') + ';',
               'static const uint8_t companion_motion[10][3] = ' + str([list(appearance.PERSONALITY[d][1:]) for d in art.IDS]).replace('[','{').replace(']','}').replace('(','{').replace(')','}') + ';']
    (OUT / 'companion_art.h').write_text('\n'.join(header) + '\n')
    (OUT / 'companion_art.pack').write_bytes(blob)
    manifest = dict(format='zlib(RGB565BE + alpha8 + shade8 + coat8 + marks4x8)', species=art.IDS, sizes=SIZES,
        source_sha256=hashlib.sha256(SOURCE.read_bytes()).hexdigest(), bytes=len(blob),
        sha256=hashlib.sha256(blob).hexdigest(), cache_bytes=sum(capacities), unique_blocks=len(memo))
    (OUT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    for block in blocks:
        raw = zlib.decompress(blob[block['offset']:block['offset'] + block['length']])
        assert len(raw) == block['raw'] and hashlib.sha256(raw).hexdigest() == block['sha256']
    assert len(blob) < 6 * 1024 * 1024, 'Must fit both OTA slots with firmware and fonts.'
    print(json.dumps(manifest))


if __name__ == '__main__':
    main()
