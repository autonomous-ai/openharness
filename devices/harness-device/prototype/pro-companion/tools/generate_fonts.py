"""Bake local Avenir outlines into bounded 4-bit proportional text atlases."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import math

root = Path(__file__).resolve().parents[1]
out = root / 'generated'
out.mkdir(exist_ok=True)
source = ['#include "pro_canvas.h"\n']
vietnamese = list(range(0x1ea0, 0x1efa)) + [0x102,0x103,0x110,0x111,0x128,0x129,
                                        0x168,0x169,0x1a0,0x1a1,0x1af,0x1b0]
for size in (24, 32, 42, 56):
    height = math.ceil(size * 1.375)
    f = ImageFont.truetype('/System/Library/Fonts/Avenir Next.ttc', size * 2, index=5 if size < 42 else 2)
    data = bytearray()
    glyphs = []
    masks = {}
    for cp in list(range(32, 256)) + vietnamese:
        ch = chr(cp) if cp < 127 or cp >= 160 else '?'
        advance = max(1, math.ceil(f.getlength(ch) / 2))
        width = advance + 2
        im = Image.new('L', (width * 2, height * 2))
        baseline = size * 2
        if cp in vietnamese:
            # Keep stacked accents and below-letter dots inside the cell.
            _, top, _, bottom = f.getbbox(ch, anchor='ls')
            assert bottom - top <= height * 2 - 2
            baseline = max(1 - top, min(baseline, height * 2 - bottom - 1))
        ImageDraw.Draw(im).text((2, baseline), ch, font=f, fill=255, anchor='ls')
        im = im.resize((width, height), Image.Resampling.LANCZOS)
        a = [min(15, (v + 8) // 17) for v in im.tobytes()]
        if len(a) & 1: a.append(0)
        packed = bytes((a[i] << 4) | a[i+1] for i in range(0,len(a),2))
        key = (width, advance, packed)
        if key not in masks:
            # Glyphs address complete masks by offset, so transparent boundary
            # bytes can be shared without changing any pixels or font metrics.
            leading = len(packed) - len(packed.lstrip(b'\0'))
            trailing = len(data) - len(data.rstrip(b'\0'))
            overlap = min(leading, trailing)
            masks[key] = len(data) - overlap
            data.extend(packed[overlap:])
        glyphs.append((masks[key], width, advance))
    source.append(f'static const uint8_t alpha_{size}[]={{\n')
    source.extend(','.join(str(v) for v in data[i:i+96])+',\n' for i in range(0,len(data),96))
    source.append('};\n')
    source.append(f'static const ht_pro_glyph_t glyphs_{size}[]={{\n')
    source.extend('{%d,%d,%d},\n'%g for g in glyphs)
    source.append('};\n')
    source.append(f'const ht_pro_font_t ht_pro_{size}={{32,255,{height},{len(glyphs)},glyphs_{size},alpha_{size}}};\n')
    print(size, height, len(data))
(out/'pro_fonts.c').write_text(''.join(source))
