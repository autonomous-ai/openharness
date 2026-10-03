#!/usr/bin/env python3
"""Geist Mono art atlases for the shared portrait sizes, sampled at 4x."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
out = ['// Generated from Geist Mono Regular, SIL OFL 1.1; fonts/GeistMono-OFL.txt.']
for width, height in ((2, 4), (3, 6), (4, 8), (6, 12)):
    font = ImageFont.truetype(str(ROOT / 'fonts/GeistMono-Regular.ttf'), round(width / .6 * 4))
    data = []
    for cp in range(32, 127):
        im = Image.new('L', (width * 4, height * 4))
        ImageDraw.Draw(im).text((0, height * 3), chr(cp), font=font, fill=255, anchor='ls')
        im = im.resize((width, height), Image.Resampling.LANCZOS)
        values = [min(3, (v + 42) // 85) for v in im.get_flattened_data()]
        values += [0] * (-len(values) % 4)
        data.extend(sum(values[j + k] << (6 - 2 * k) for k in range(4)) for j in range(0, len(values), 4))
    out.append(f'static const uint8_t character_font_{height}_pixels[] = {{')
    out.extend('    ' + ','.join(map(str, data[i:i + 24])) + ',' for i in range(0, len(data), 24))
    out += ['};', f'static const ht_font_t character_font_{height} = {{32,126,{width},{height},character_font_{height}_pixels}};']
(ROOT / 'main/ui/habitat/character_fonts.inc').write_text('\n'.join(out) + '\n')
print('Character portrait atlases: 2x4, 3x6, 4x8 and 6x12')
