#!/usr/bin/env python3
"""Bake regular-weight outlines into the bounded 4-bit Pro text atlases.

    python3 scripts/gen_fonts.py [--font PATH] --out FILE

Emits ht_pro_24, ht_pro_32, ht_pro_42 and ht_pro_56 (ht_pro_font_t, see main/display/pro_font_type.h).
The default font is the system sans on macOS when present, else the bundled Liberation Sans.
Also emits the Pets faces (ph_sb_*, ph_rg_*, ph_mono_*, ph_num_*, ph_bd_*) from the committed Inter / JetBrains Mono TTFs in
fonts/, whatever --font says: full coverage, plus the CONSOLE_EXTRA marks appended after the Vietnamese entries.
The output is a build artifact; it is generated at build time and never committed.
"""
import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SYSTEM_FONT = Path('/System/Library/Fonts/Helvetica.ttc')
BUNDLED_FONT = ROOT / 'fonts' / 'LiberationSans-Regular.ttf'
SIZES = (24, 32, 42, 56)
# Pod draws only these characters at the big sizes (test_only_sparse_chars_drawn guards it), so only they
# get masks. Every other glyph keeps its metrics and points at a shared run of zeros (draws nothing).
# 32 is only ever the ">_" of the default engine mark (pod_mark_default_big).
SPARSE = {32: ">_", 42: "#>_?", 56: "#>_?"}
# The 90 Vietnamese precomposed letters, then the 12 letters outside that block.
# Keep in sync with ht_pro_vietnamese_index().
VIETNAMESE = list(range(0x1ea0, 0x1efa)) + [0x102, 0x103, 0x110, 0x111, 0x128, 0x129,
                                            0x168, 0x169, 0x1a0, 0x1a1, 0x1af, 0x1b0]
# Pets faces: (symbol, font file, size). Extras follow the Vietnamese entries; each face lists its own extras in its extras table (ht_pro_font_t.extras), which pro_canvas.c searches.
# Pets glyphs are cropped to their inked rows (ht_pro_glyph_t top/rows). A mark the face lacks gets a copy of '?', so it never draws as an empty box.
FONTS = ROOT / 'fonts'
CONSOLE = [('ph_sb_48', 'Inter-SemiBold.ttf', 48), ('ph_sb_34', 'Inter-SemiBold.ttf', 34),
           ('ph_sb_26', 'Inter-SemiBold.ttf', 26), ('ph_sb_22', 'Inter-SemiBold.ttf', 22),
           ('ph_rg_24', 'Inter-Regular.ttf', 24), ('ph_mono_26', 'JetBrainsMono-Medium.ttf', 26),
           ('ph_mono_18', 'JetBrainsMono-Medium.ttf', 18),
           ('ph_sb_32', 'Inter-SemiBold.ttf', 32), ('ph_rg_36', 'Inter-Regular.ttf', 36),
           ('ph_mono_22', 'JetBrainsMono-Medium.ttf', 22),
           ('ph_rg_28', 'Inter-Regular.ttf', 28),   # the notice toast's message
           # Home's agent count on a cover card: digits only, 230 px (the cover cards' numerals); SemiBold plus a stroke stands in for the mockup's ExtraBold
           ('ph_num_230', 'Inter-SemiBold.ttf', 230),
           # The round dial's wordmark, larger: Home with no tabs draws "Harness"; the Update ring its percent (Inter Bold 84, only those glyphs)
           ('ph_bd_84', 'Inter-Bold.ttf', 84)]
CONSOLE_STROKE = {'ph_num_230': 3}   # at the 2x supersample
# Faces that draw a known set of characters keep only those (the font total cap is 900 KB). ph_sb_48 draws "Notices", the Update ring's "%" and "Harness" title.
CONSOLE_CUT = {'ph_sb_48': '0123456789.-+_% abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ\u2026',
               'ph_num_230': '0123456789',
               'ph_bd_84': 'Harness0123456789'}
CONSOLE_EXTRA = [0x2026, 0x2192, 0x2191, 0x2193, 0x2190, 0x21e2, 0x25b2, 0x25c6, 0x2713]


def has_glyph(f, cp):
    """True when the face draws cp itself (not its .notdef box)."""
    return bytes(f.getmask(chr(cp))) != bytes(f.getmask(chr(0x10fffe)))


def bake(font_path, size, sparse_chars=None, extras=(), crop=False, stroke=0):
    height = math.ceil(size * 1.375)
    f = ImageFont.truetype(str(font_path), size * 2, index=0)  # 2x supersampling
    data = bytearray()
    glyphs = []
    masks = {}
    sparse = SPARSE.get(size) if sparse_chars is None else (sparse_chars or None)
    blank = 0  # length of the zero run at offset 0
    for cp in list(range(32, 256)) + VIETNAMESE + list(extras):
        ch = chr(cp) if cp < 127 or (160 <= cp and (cp not in extras or has_glyph(f, cp))) else '?'
        advance = max(1, math.ceil(f.getlength(ch) / 2))
        width = advance + 2
        im = Image.new('L', (width * 2, height * 2))
        baseline = size * 2
        if cp in VIETNAMESE:
            # Keep stacked accents and below-letter dots inside the cell.
            _, top, _, bottom = f.getbbox(ch, anchor='ls')
            assert bottom - top <= height * 2 - 2, 'U+%04X does not fit' % cp
            baseline = max(1 - top, min(baseline, height * 2 - bottom - 1))
        ImageDraw.Draw(im).text((2, baseline), ch, font=f, fill=255, anchor='ls', stroke_width=stroke, stroke_fill=255)
        im = im.resize((width, height), Image.Resampling.LANCZOS)
        a = [min(15, (v + 8) // 17) for v in im.tobytes()]
        top = rows = 0
        if crop:   # keep only the rows with ink (at least one): the cell is taller than most letters
            live = [y for y in range(height) if any(a[y * width:(y + 1) * width])] or [0]
            top, rows = live[0], live[-1] - live[0] + 1
            a = a[top * width:(top + rows) * width]
        if len(a) & 1:
            a.append(0)
        packed = bytes((a[i] << 4) | a[i + 1] for i in range(0, len(a), 2))
        if sparse is not None and chr(cp) not in sparse:
            # A cut glyph keeps its metrics and points at the zero run. A cropped face (rows is a real count) gives it one blank row: rows == 0
            # would mean the font's full height and read past the run into the next mask. The uncropped 42/56 faces are all rows == 0, so their run is a full cell.
            blank = max(blank, (width + 1) // 2 if crop else len(packed))
            glyphs.append((-1, width, advance, 0, 1 if crop else 0))
            continue
        key = (width, advance, top, rows, packed)
        if key not in masks:
            # Glyphs address complete masks by offset, so transparent boundary
            # bytes can be shared without changing any pixels or font metrics.
            leading = len(packed) - len(packed.lstrip(b'\0'))
            trailing = len(data) - len(data.rstrip(b'\0'))
            overlap = min(leading, trailing)
            masks[key] = len(data) - overlap
            data.extend(packed[overlap:])
        glyphs.append((masks[key], width, advance, top, rows))
    if blank:   # shift the real masks past the zero run; skipped glyphs point at its start
        glyphs = [(o + blank, w, a, tp, r) if o >= 0 else (0, w, a, 0, r) for o, w, a, tp, r in glyphs]
        data = bytes(blank) + data
    return height, data, glyphs


def emit(source, name, height, data, glyphs, extras=()):
    # Every field must fit its C type (ht_pro_glyph_t: uint32 offset, four uint8; ht_pro_font_t: uint16 height and glyph_count, uint8 extra_count).
    assert height <= 0xffff and len(glyphs) <= 0xffff and len(extras) <= 0xff, name
    for i, (offset, width, advance, top, rows) in enumerate(glyphs):
        assert 0 <= offset <= 0xffffffff, '%s glyph %d offset %d' % (name, i, offset)
        assert max(width, advance, top, rows) <= 0xff and min(width, advance, top, rows) >= 0, \
            '%s glyph %d (w %d adv %d top %d rows %d) does not fit 8 bits' % (name, i, width, advance, top, rows)
        assert offset + ((rows or height) * width + 1) // 2 <= len(data), '%s glyph %d reads past the alpha data' % (name, i)
    tag = name.removeprefix('ht_pro_')   # alpha_24, glyphs_24
    source.append(f'static const uint8_t alpha_{tag}[]={{\n')
    source.extend(','.join(str(v) for v in data[i:i + 96]) + ',\n' for i in range(0, len(data), 96))
    source.append('};\n')
    source.append(f'static const ht_pro_glyph_t glyphs_{tag}[]={{\n')
    source.extend('{' + ','.join(map(str, g)) + '},\n' for g in glyphs)
    source.append('};\n')
    if extras:   # the code points baked after the Vietnamese entries, in glyph order (pro_canvas.c code() searches it)
        source.append(f'static const uint16_t extras_{tag}[]={{' + ','.join('0x%04x' % cp for cp in extras) + '};\n')
        table = f'extras_{tag},{len(extras)}'
    else:
        table = '0,0'
    source.append(f'const ht_pro_font_t {name}={{32,255,{height},{len(glyphs)},glyphs_{tag},alpha_{tag},{table}}};\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--font', type=Path,
                    default=SYSTEM_FONT if SYSTEM_FONT.exists() else BUNDLED_FONT)
    ap.add_argument('--out', type=Path, required=True)
    args = ap.parse_args()

    source = ['/* Generated by scripts/gen_fonts.py. Do not edit or commit. */\n',
              '#include "pro_font_type.h"\n']
    for size in SIZES:
        height, data, glyphs = bake(args.font, size)
        emit(source, f'ht_pro_{size}', height, data, glyphs)
    for name, ttf, size in CONSOLE:
        emit(source, name, *bake(FONTS / ttf, size, sparse_chars=CONSOLE_CUT.get(name, ''), extras=CONSOLE_EXTRA, crop=True, stroke=CONSOLE_STROKE.get(name, 0)), CONSOLE_EXTRA)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(''.join(source))


if __name__ == '__main__':
    main()
