#!/usr/bin/env python3
"""The Focus skin's fonts and icons, copied out of the LVGL firmware that shipped as 0.0.86.

    python3 devices/harness-device/firmware/scripts/gen_lvgl_assets.py [LVGL_DIR]

Nothing here is re-drawn. The Montserrat faces are LVGL 9.5.0's built-in ones, read from an LVGL
checkout (LVGL_DIR, default below), cut down to the two FontAwesome symbols Focus still draws (the bell
and the close cross; every word and number on the Focus skin is Literata, gen_focus_faces.py — the old
firmware's Geist faces are no longer emitted); the engine marks and the microphone are the old
icons_*.c ARGB8888 arrays, read from git at SOURCE (the tree 0.0.86 was built from). Glyph bitmaps are copied byte for byte. The 28 px header marks are LVGL's
own scaling of the 20 px ones, ported from lv_draw_sw_transform.c so the pixels are the ones the old
dial drew. Writes:

    main/ui/habitat/lvgl_fonts.c   the two icon faces, as ht_pfont_t
    main/ui/habitat/lvgl_icons.c   the icons, as ht_icon_t (RGB565 in panel order + alpha)
    assets/lvgl/SPEC.md            what was taken, from where, and how it is laid out
"""
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
repo = root.parents[1]
SOURCE = 'e96fc50c^'   # 0.0.86 was uploaded 17 s before e96fc50c "chore(device): firmware 0.0.86"
LVGL = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / (
    'go/src/github.com/autonomous-ai/autonomous-code/apps/esp32-circle/managed_components/lvgl__lvgl')

# Icon faces only: Montserrat cut down to a space (the face's cell width) and the one symbol drawn.
MONT = ['montserrat_22', 'montserrat_14']
USE = {'montserrat_22': 'the close cross', 'montserrat_14': 'the bell glyph in the pill'}
# Text codepoints kept: Latin-1, Latin Extended-A, the Vietnamese horn letters and the precomposed
# Vietnamese block, a little punctuation, ✓ ✗. Literata (gen_focus_faces.py) is cut to this set.
TEXT = (set(range(0x20, 0x7F)) | set(range(0xA0, 0x180)) | {0x1A0, 0x1A1, 0x1AF, 0x1B0} |
        set(range(0x1EA0, 0x1EFA)) |
        {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2039, 0x203A, 0x2713, 0x2717})
BELL, CROSS = 0xF0F3, 0xF00D
SYMBOL = {'montserrat_22': CROSS, 'montserrat_14': BELL}
ENGINES = ['claude', 'codex', 'cursor', 'opencode', 'grok', 'copilot', 'amp', 'devin', 'kilo', 'pi',
           'hermes', 'muse', 'agy', 'commandcode']
CLAUDE = (0xcc, 0x7c, 0x5e)


def git(path):
    return subprocess.run(['git', 'show', f'{SOURCE}:{path}'], cwd=repo, check=True,
                          capture_output=True, text=True).stdout


def numbers(text):
    return [int(v, 0) for v in re.findall(r'-?0x[0-9a-fA-F]+|-?\d+', text)]


def array(src, name):
    m = re.search(name + r'\[\]\s*=\s*\{(.*?)\};', src, re.S)
    return numbers(re.sub(r'/\*.*?\*/', '', m.group(1), flags=re.S)) if m else []


def lv_font(src):
    """Everything a proportional ht_pfont_t needs, read out of one lv_font_conv C file."""
    font = {
        'bitmap': bytes(array(src, 'glyph_bitmap')),
        'dsc': [tuple(map(int, g)) for g in re.findall(
            r'\{\.bitmap_index = (\d+), \.adv_w = (\d+), \.box_w = (\d+), \.box_h = (\d+), '
            r'\.ofs_x = (-?\d+), \.ofs_y = (-?\d+)\}', src)],
        'line': int(re.search(r'\.line_height = (\d+)', src).group(1)),
        'base': int(re.search(r'\.base_line = (\d+)', src).group(1)),
        'left': array(src, 'kern_left_class_mapping'),
        'right': array(src, 'kern_right_class_mapping'),
        'kern': array(src, 'kern_class_values'),
        'rcnt': int(re.search(r'\.right_class_cnt\s*=\s*(\d+)', src).group(1)),
        'bpp': int(re.search(r'\.bpp = (\d+)', src).group(1)),
        'format': int(re.search(r'\.bitmap_format = (\d+)', src).group(1)),
    }
    assert font['bpp'] == 4 and font['format'] == 0, 'expects --bpp 4 --no-compress'
    cmap = {}
    for m in re.finditer(r'\.range_start = (\d+), \.range_length = (\d+), \.glyph_id_start = (\d+),\s*'
                         r'\.unicode_list = (\w+), \.glyph_id_ofs_list = (\w+), \.list_length = (\d+), '
                         r'\.type = (\w+)', src):
        start, length, gid, ulist, ofs, count, kind = m.groups()
        start, length, gid = int(start), int(length), int(gid)
        assert ofs == 'NULL' or kind.endswith('FORMAT0_FULL')
        if kind.endswith('FORMAT0_FULL'):
            # lv_font_conv shares one glyph between codepoints that draw alike: an offset per codepoint.
            for i, d in enumerate(array(src, ofs)):
                cmap[start + i] = gid + d
        elif kind.endswith('FORMAT0_TINY'):
            for i in range(length):
                cmap[start + i] = gid + i
        elif kind.endswith('SPARSE_TINY'):
            for i, d in enumerate(array(src, ulist)):
                cmap[start + d] = gid + i
        else:
            raise SystemExit(f'unhandled cmap {kind}')
    font['cmap'] = cmap
    return font


def emit_font(name, font, keep, fallback='NULL'):
    """One face: glyphs in codepoint order, each glyph's bitmap copied verbatim (LVGL's continuous
    4-bit stream), its kern classes, and LVGL's line metrics."""
    codes = sorted(cp for cp in font['cmap'] if cp in keep)
    px, table, kl, kr = bytearray(), [], [], []
    for cp in codes:
        gid = font['cmap'][cp]
        index, adv, w, h, ox, oy = font['dsc'][gid]
        size = (w * h + 1) // 2
        top = font['line'] - font['base'] - h - oy          # lv_draw_label.c: y1 of the letter
        table.append((len(px), adv, w, h, ox, top))
        px += font['bitmap'][index:index + size]
        kl.append(font['left'][gid] if font['left'] else 0)
        kr.append(font['right'][gid] if font['right'] else 0)
    space = next(adv for cp, (o, adv, *_) in zip(codes, table) if cp == 0x20) if 0x20 in codes else 0
    c = [f'// {name}: {len(codes)} glyphs, line {font["line"]}, base {font["base"]}, {len(px)} bitmap bytes.\n',
         f'static const uint8_t {name}_px[] = {{\n']
    for i in range(0, len(px), 24):
        c.append('  ' + ','.join(map(str, px[i:i + 24])) + ',\n')
    c.append('};\n')
    c.append(f'static const ht_glyph_t {name}_glyphs[] = {{\n')
    for g in table:
        c.append('  {%d,%d,%d,%d,%d,%d},\n' % g)
    c.append('};\n')
    c.append(f'static const uint16_t {name}_codes[] = {{' + ','.join(map(str, codes)) + '};\n')
    c.append(f'static const uint8_t {name}_kl[] = {{' + ','.join(map(str, kl)) + '};\n')
    c.append(f'static const uint8_t {name}_kr[] = {{' + ','.join(map(str, kr)) + '};\n')
    c.append(f'static const int8_t {name}_kv[] = {{' + ','.join(map(str, font['kern'])) + '};\n')
    c.append(f'const ht_pfont_t ht_lv_{name} = {{{{1,0,{(space + 8) >> 4},{font["line"]},{name}_px}},'
             f'{name}_glyphs,{name}_codes,{len(codes)},{font["line"] - font["base"]},'
             f'{name}_kl,{name}_kr,{name}_kv,{font["rcnt"]},{fallback}}};\n')
    return ''.join(c), len(px) + len(table) * 12 + len(codes) * 4 + len(font['kern'])


# ── icons ──────────────────────────────────────────────────────────────────────────────────────────
def argb(src, symbol):
    """An LVGL ARGB8888 image (B,G,R,A bytes) as rows of (r,g,b,a)."""
    m = re.search(symbol + r'_map\[\]\s*=\s*\{(.*?)\};', src, re.S)
    data = numbers(re.sub(r'/\*.*?\*/', '', m.group(1), flags=re.S))
    d = re.search(r'lv_image_dsc_t ' + symbol + r'\s*=\s*\{.*?\.header\.w = (\d+), \.header\.h = (\d+)',
                  src, re.S)
    w, h = int(d.group(1)), int(d.group(2))
    return w, h, [[(data[(y * w + x) * 4 + 2], data[(y * w + x) * 4 + 1], data[(y * w + x) * 4],
                    data[(y * w + x) * 4 + 3]) for x in range(w)] for y in range(h)]


def udiv255(x):
    return (x * 0x8081) >> 0x17


def mix32(fg, bg):
    """lv_color_mix32: fg's alpha is the mix; the result keeps bg's alpha."""
    r, g, b, a = fg
    if a >= 253:
        return (r, g, b, bg[3])
    if a <= 2:
        return bg
    return (udiv255(r * a + bg[0] * (255 - a)), udiv255(g * a + bg[1] * (255 - a)),
            udiv255(b * a + bg[2] * (255 - a)), bg[3])


def scaled(img, w, h, scale, pivot):
    """lv_draw_sw_transform.c for a scale-only ARGB8888 draw with antialias: the whole transformed
    area in one pass, as a 28 px mark is drawn. Returns (x1, rows) with x1 the area's first column
    relative to the image origin."""
    x1 = ((0 - pivot) * scale >> 8) + pivot
    x2 = ((w - 1 - pivot) * scale >> 8) + pivot
    x_max = ((w - 1 - pivot) * scale >> 8) + pivot

    def up(v):          # transform_point_upscaled, C truncating division
        q = (v - pivot) * 256 * 256
        return (abs(q) // scale) * (1 if q >= 0 else -1) + pivot * 256
    lo, hi = min(x1, x_max), min(x2, x_max)
    n = x2 - x1 + 1
    step = (256 * (up(hi) - up(lo))) // (n - 1) if n > 1 else 0
    start = up(lo) + 0x80
    out = []
    for yi in range(n):
        ys = start + ((step * yi) >> 8)
        row = []
        for xi in range(n):
            xs = start + ((step * xi) >> 8)
            xs_int, ys_int = xs >> 8, ys >> 8
            if not (0 <= xs_int < w and 0 <= ys_int < h):
                row.append((0, 0, 0, 0))
                continue
            xf, yf = xs & 0xFF, ys & 0xFF
            xn, xf = (-1, 0x7F - xf) if xf < 0x80 else (1, xf - 0x80)
            yn, yf = (-1, 0x7F - yf) if yf < 0x80 else (1, yf - 0x80)
            d = img[ys_int][xs_int]
            if 0 <= xs_int + xn <= w - 1 and 0 <= ys_int + yn <= h - 1:
                hor, ver = img[ys_int][xs_int + xn], img[ys_int + yn][xs_int]
                if ver[3] == 0:
                    d = (d[0], d[1], d[2], (d[3] * (0xFF - yf)) >> 8)
                elif d != ver:
                    a = ((ver[3] * yf) + (d[3] * (0xFF - yf))) >> 8 if d[3] else d[3]
                    d = mix32((ver[0], ver[1], ver[2], yf), (d[0], d[1], d[2], a))
                if hor[3] == 0:
                    d = (d[0], d[1], d[2], (d[3] * (0xFF - xf)) >> 8)
                elif d != hor:
                    a = ((hor[3] * xf) + (d[3] * (0xFF - xf))) >> 8 if d[3] else d[3]
                    d = mix32((hor[0], hor[1], hor[2], xf), (d[0], d[1], d[2], a))
            elif (xs_int == 0 and xn < 0) or (xs_int == w - 1 and xn > 0):
                d = (d[0], d[1], d[2], (d[3] * (0x7F - xf)) >> 7)
            elif (ys_int == 0 and yn < 0) or (ys_int == h - 1 and yn > 0):
                d = (d[0], d[1], d[2], (d[3] * (0x7F - yf)) >> 7)
            row.append(d)
        out.append(row)
    return x1, out


def emit_icon(name, rows):
    """RGB565 truncated as lv_color_24_16_mix reads it, byte-swapped for the panel, and alpha."""
    px, alpha = [], []
    for row in rows:
        for r, g, b, a in row:
            v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
            px.append(((v << 8) | (v >> 8)) & 0xFFFF)
            alpha.append(a)
    h, w = len(rows), len(rows[0])
    return (f'static const uint16_t {name}_px[] = {{' + ','.join(map(str, px)) + '};\n'
            f'static const uint8_t {name}_a[] = {{' + ','.join(map(str, alpha)) + '};\n',
            f'{{{w},{h},{name}_px,{name}_a}}', len(px) * 3)


def main():
    fonts = ['// Generated by scripts/gen_lvgl_assets.py. Do not edit.\n'
             '// Icon faces only: LVGL 9.5.0 Montserrat (MIT; fonts OFL) cut down to the bell and the close cross.\n'
             '#include "terminal.h"\n']
    spec = []
    total = 0
    for name in MONT:
        f = lv_font((LVGL / f'src/font/lv_font_{name}.c').read_text())
        f['left'], f['right'], f['kern'], f['rcnt'] = [], [], [0], 1   # a lone symbol has nothing to kern with
        code, size = emit_font(name, f, {0x20, SYMBOL[name]})
        fonts.append(code)
        total += size
        spec.append(f'| {USE[name]} | `{name}` | {f["line"]} / {f["base"]} | {size:,} |')
        print(f'{name}: line {f["line"]}, base {f["base"]}, {size} bytes')
    (root / 'main/ui/habitat/lvgl_fonts.c').write_text(''.join(fonts))

    engine = git('devices/harness-device/firmware/main/ui/icons_engine.c')
    settings = git('devices/harness-device/firmware/main/ui/icons_settings.c')
    icons = ['// Generated by scripts/gen_lvgl_assets.py. Do not edit.\n'
             f'// The old firmware\'s icons_engine.c / icons_settings.c at {SOURCE}.\n#include "terminal.h"\n']
    small, big = [], []
    for name in ENGINES:
        w, h, img = argb(engine, f'icon_{name}')
        assert (w, h) == (20, 20), name
        # 28 px in the header: scale 358 about (10,10), inner-aligned in a 28 box at offset 4.
        x1, rows = scaled(img, w, h, 28 * 256 // 20, 10)
        assert x1 == -4 and len(rows) == 27, (x1, len(rows))
        if name == 'claude':   # recoloured at LV_OPA_COVER: the mark keeps its alpha, takes COL_CLAUDE
            img = [[CLAUDE + (p[3],) for p in row] for row in img]
            rows = [[CLAUDE + (p[3],) for p in row] for row in rows]
        c, ref, n = emit_icon(f'engine20_{name}', img)
        icons.append(c); small.append(ref); total += n
        c, ref, n = emit_icon(f'engine28_{name}', rows)
        icons.append(c); big.append(ref); total += n
    icons.append('const ht_icon_t ht_icon_engine20[14] = {' + ','.join(small) + '};\n')
    icons.append('const ht_icon_t ht_icon_engine28[14] = {' + ','.join(big) + '};\n')
    w, h, img = argb(settings, 'icon_act_voice')
    c, ref, n = emit_icon('mic', img)
    icons.append(c + f'const ht_icon_t ht_icon_mic = {ref};\n'); total += n
    (root / 'main/ui/habitat/lvgl_icons.c').write_text(''.join(icons))
    print(f'icons: 14 x 20 px, 14 x 27 px (scaled), mic {w}x{h}; total fonts+icons {total} bytes')

    spec_path = root / 'assets/lvgl/SPEC.md'
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(SPEC.format(source=SOURCE, fonts='\n'.join(spec)))


SPEC = '''# The live dial, as data

What the Focus skin takes from the LVGL firmware that shipped as **0.0.86**, and where from. Regenerate
everything here with `python3 devices/harness-device/firmware/scripts/gen_lvgl_assets.py`.

**Provenance.** `0.0.86.bin` on GCS: Last-Modified 24 Sep 2026 11:17:54 GMT, 3,175,728 bytes. The
version bump `e96fc50c` landed 17 s later, so the build is `{source}`. LVGL 9.5.0 (component hash
184e5325…). After the release, e5c13558 moved the pill's bell to montserrat_22; the device draws it
in **montserrat_14**, and so does this.

## Fonts

lv_font_conv `--bpp 4 --no-compress --no-prefilter`, class kerning, copied glyph for glyph. LVGL
decode, reproduced in terminal.c: `adv_w` is 1/16 px and the advance is
`(adv_w + kern + 8) >> 4` per letter pair; a letter's box sits at `pen + ofs_x`,
`top + (line - base) - box_h - ofs_y`; coverage `v * 17` is blended with `lv_color_16_16_mix`.

| use | font | line / base | bytes kept |
|---|---|---|---|
{fonts}

## Icons

ARGB8888 (B,G,R,A, straight alpha), blended with `lv_color_24_16_mix`.

| icon | source | drawn |
|---|---|---|
| 14 engine marks | `icons_engine.c`, 20×20 | header: scaled 358/256 about (10,10) → 27 px from box offset 0 (LVGL's transform, ported); inbox: 20 native |
| Claude | white mark, shape in alpha | recoloured `0xcc7c5e`, alpha kept; the others keep their colours |
| microphone | `icon_act_voice`, 44×44, `#00ff2f` baked | native, centred on (233, 393) |
| bell, cross | FontAwesome U+F0F3 / U+F00D in Montserrat | text |

## Layout of the LVGL firmware (COL_FG `0xeaeaf0`, COL_MUTED `0x8a8a99`)

Historical: the face names below are the old firmware's Geist ones. The Focus skin now sets every word and
number in Literata (focus_faces.c, gen_focus_faces.py, docs/plans/2026-10-02-literata-only.md); only the
boxes, colours and spacing here still apply.

| item | values |
|---|---|
| header | 384 wide at x 41: 28 mark + 10 gap + name `geist_med_38`; 1 line with a recap or a turn, up to 2 when empty |
| tab pill | header top − 51 (y 68 with a card), 41 tall, 12 px pad, fully round, `0x1c1e24`@70% (= `0x141519` on black), 1 px `0x3a3f4b`; `montserrat_24`, ≤ 340 px "…" (here ≤ 314 with its pad, the widest inside r 230) |
| recap card | y 191, 384×119, radius 28, `0x23252f`, 1 px `0xa6a6a6`@20% (= `0x3d3f47`), pad 18/19; 2 lines of `geist_med_28`, 38 + 3 spacing, 346 wide, "…"; red `0xff5a5a` on error |
| no card | the name + body block is centred: top = 233 − ⌊(name + 21 + body) / 2⌋, clamped to [75, 302 − block] |
| working | `geist_med_32` `0x00ff2f`, "verb… 34s" (then "1m 05s") |
| empty | "No activity yet", `geist_reg_38` `0x585863`, 276 wide, wraps |
| bell pill | y 22, 32 tall, `0x006fff`, pad 13/4, gap 6: bell `montserrat_14`, count `montserrat_22`, COL_FG |
| drawer | ground `0x16161c`; close pill 60×32 at (203,16), COL_FG@10 %; list at (53,107) 360×320, gap 12 |
| drawer card | 360 wide, radius 26, `0x23252f`, 1 px 20 %, pad 16/14, row gap 8: machine `geist_reg_20` muted; [20 px mark or 8 px `0x04fe08` dot] 8 gap, name `geist_reg_20` `0x04fe08`; message `geist_reg_25` COL_FG, wraps, ≤ 100 chars "…" |
'''

if __name__ == '__main__':
    main()
