#!/usr/bin/env python3
"""The Focus skin's generated proportional faces, converted with lv_font_conv.

    python3 devices/harness-device/firmware/scripts/gen_focus_faces.py [--literata-instance]

Writes main/ui/habitat/focus_faces.c and focus_faces.h. Focus sets every word and number in Literata
(owner, 2026-10-02: one font; docs/plans/2026-10-02-literata-only.md), in five faces: literata_20 (small
labels, the PANES / TABS header, inbox machine and agent, the bell count), literata_25 (an inbox message,
the "Choose a tab" pill), literata_med_26 (the curved name and the lower-arc status and Listening sweep),
literata_30 (the recap, pane and tab names, the working status) and literata_36 (the resting line).
Only the two FontAwesome symbols (bell, close cross) stay in lvgl_fonts.c's Montserrat, which
gen_lvgl_assets.py cuts to them. Each face is converted as the LVGL faces were: lv_font_conv
(pinned, run through npx) with --bpp 4 --no-compress --no-prefilter, kerning on, over gen_lvgl_assets.py's
TEXT codepoints, then parsed with that script's lv_font() / emit_font(). Literata has no check / cross
marks (U+2713 / U+2717), so each face takes those two codepoints from Noto Sans Symbols 2 (OFL 1.1, vendored
as fonts/NotoSansSymbols2-Regular.ttf with fonts/NotoSansSymbols2-OFL.txt) through a second --font.

Literata (OFL 1.1, fonts/Literata-OFL.txt): fonts/Literata-Regular20.ttf (opsz 20, wght 450), -Regular25 (opsz 25,
wght 400), -Medium26 (opsz 26, wght 500), -Regular30 (opsz 30, wght 380: the mockup's face(26, 380), 4 px larger)
and -Regular36 (opsz 36, wght 380) are static instances of the variable mockup/fonts-literata/Literata.ttf, each
cut down to the TEXT codepoints and kern feature, its kerning lookups unwrapped from GPOS Extension (type 9)
subtables, which lv_font_conv does not read (without them the face comes out unkerned). `--literata-instance`
re-cuts them (LITERATA). The default run reads the vendored files and needs node and fontTools (pip install
fonttools: it reads each font's coverage).
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gen_lvgl_assets as base   # noqa: E402  (importing has no side effects; its main() is guarded)

root = base.root
LV_FONT_CONV = 'lv_font_conv@1.5.2'
FONTS = root / 'fonts'
# Literata has no check / cross marks; they come from Noto Sans Symbols 2 (OFL, vendored), so recaps keep showing them.
MARKS = {0x2713, 0x2717}
MARKS_FONT = FONTS / 'NotoSansSymbols2-Regular.ttf'   # github.com/google/fonts ofl/notosanssymbols2
KEEP = base.TEXT
assert MARKS <= KEEP

# name -> (font file in fonts/, px, fallback face).
# Literata instances: file stem -> (opsz, wght).
LITERATA = {'Literata-Regular20': (20, 450), 'Literata-Regular25': (25, 400), 'Literata-Medium26': (26, 500),
            'Literata-Regular30': (30, 380), 'Literata-Regular36': (36, 380)}
# The curved Literata name's mid-caps offset on the upper arc (px above the baseline); terminal.c's ARC_PROP_MID is 11.
LITERATA_ARC_MID = 16
# On the lower arc the glyphs are upright and the descenders point at the glass's edge, so the face keeps the
# default offset there (the stacked marks of a capital point inward).
LITERATA_ARC_MID_LOWER = 11
FACES = [
    ('literata_20', 'Literata-Regular20', 20, 'NULL'),   # small labels: PANES / TABS, inbox machine and agent, the bell count
    ('literata_25', 'Literata-Regular25', 25, 'NULL'),   # an inbox message, the "Choose a tab" pill
    ('literata_med_26', 'Literata-Medium26', 26, 'NULL'),   # the curved name, the lower-arc status and the Listening sweep
    ('literata_30', 'Literata-Regular30', 30, 'NULL'),   # the recap (Kindle dark), pane and tab names, the working status
    ('literata_36', 'Literata-Regular36', 36, 'NULL'),   # the resting line
]


def instance_literata():
    for stem, (opsz, wght) in LITERATA.items():
        instance_literata_one(stem, opsz, wght)


def instance_literata_one(stem, opsz, wght):
    from fontTools import subset
    from fontTools.ttLib import TTFont
    from fontTools.varLib import instancer
    font = instancer.instantiateVariableFont(TTFont(root / 'mockup/fonts-literata/Literata.ttf'),
                                             {'opsz': opsz, 'wght': wght})
    options = subset.Options()
    options.layout_features, options.name_IDs, options.notdef_outline = ['kern'], ['*'], True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(KEEP))
    subsetter.subset(font)
    with tempfile.TemporaryDirectory() as t:   # a saved and reloaded font shows its Extension wrappers
        font.save(Path(t) / 'l.ttf')
        font = TTFont(Path(t) / 'l.ttf')
    for lookup in font['GPOS'].table.LookupList.Lookup:
        if lookup.LookupType == 9:
            lookup.LookupType = lookup.SubTable[0].ExtensionLookupType
            lookup.SubTable = [sub.ExtSubTable for sub in lookup.SubTable]
    font.save(FONTS / f'{stem}.ttf')


def ranges(codes):
    """Sorted codepoints as lv_font_conv -r arguments: runs a-b, singles a."""
    out, codes = [], sorted(codes)
    i = 0
    while i < len(codes):
        j = i
        while j + 1 < len(codes) and codes[j + 1] == codes[j] + 1:
            j += 1
        out.append(f'0x{codes[i]:X}' + (f'-0x{codes[j]:X}' if j > i else ''))
        i = j + 1
    return ','.join(out)


def covered(source):
    """The TEXT codepoints the font really has. A requested range with a hole makes lv_font_conv emit a
    format-0-full cmap, which lv_font() does not read; a face holds only what its font draws (a rare
    letter it lacks falls to '?')."""
    from fontTools.ttLib import TTFont
    return (KEEP - MARKS) & set(TTFont(FONTS / f'{source}.ttf').getBestCmap())


def convert(source, px, tmp, name):
    out = tmp / f'{name}.c'
    subprocess.run(['npx', '-y', LV_FONT_CONV, '--size', str(px), '--bpp', '4', '--format', 'lvgl',
                    '--no-compress', '--no-prefilter', '--force-fast-kern-format',
                    '--font', str(FONTS / f'{source}.ttf'), '-r', ranges(covered(source)),
                    '--font', str(MARKS_FONT), '-r', ranges(MARKS),
                    '--lv-include', 'lvgl.h', '-o', str(out)], check=True, capture_output=True, text=True)
    return out.read_text()


def main():
    if '--literata-instance' in sys.argv:
        instance_literata()
    c = ['// Generated by scripts/gen_focus_faces.py. Do not edit.\n'
         f'// Literata (OFL 1.1) through {LV_FONT_CONV}: --bpp 4 --no-compress --no-prefilter.\n'
         '#include "terminal.h"\n']
    h = ['// Generated by scripts/gen_focus_faces.py. Do not edit.\n#pragma once\n#include "terminal.h"\n']
    total = 0
    with tempfile.TemporaryDirectory() as t:
        for name, source, px, fallback in FACES:
            font = base.lv_font(convert(source, px, Path(t), name))
            code, size = base.emit_font(name, font, KEEP, fallback)
            c.append(code)
            h.append(f'extern const ht_pfont_t ht_lv_{name};\n')
            # Self-check: every TEXT codepoint the font has, the marks and the 98 Vietnamese letters were
            # kept, and the metrics are sane.
            m = re.search(rf'static const uint16_t {name}_codes\[\] = \{{(.*?)\}};', code)
            codes = {int(v) for v in m.group(1).split(',')}
            missing = (covered(source) | MARKS) - codes
            assert not missing, (name, sorted(missing))
            assert len(set(range(0x1EA0, 0x1EFA)) & codes) == 90 and {0x1A0, 0x1A1, 0x1AF, 0x1B0} <= codes
            assert 0 < font['line'] - font['base'] < font['line'], name
            total += size
            print(f'{name}: {len(codes)} glyphs, line {font["line"]}, ascent {font["line"] - font["base"]},'
                  f' {size} bytes')
    # The curved name's arc face lives with its font: terminal.c names no Focus face, so the compositor's
    # tests need not link these (terminal.h declares it).
    c.append('// The Focus curved name: Literata Medium 26 on the upper arc. Its stacked Vietnamese capitals stand tall:\n'
             '// the curve carries it 5 px nearer the centre than terminal.c\'s ARC_PROP_MID 11, so the tallest mark ends\n'
             '// inside the 128 px arc canvas. A name too long for the arc ends at a word, with no "…" (owner, 2026-10-03).\n'
             f'const ht_arc_face_t ht_arc_literata_prop = {{.prop = &ht_lv_literata_med_26, .mid = {LITERATA_ARC_MID}, .bare = true}};\n'
             '// The same face on the lower arc (the working status, the Listening sweep): upright glyphs whose descenders\n'
             '// point at the glass, so the default mid-caps offset.\n'
             f'const ht_arc_face_t ht_arc_literata_lower = {{.prop = &ht_lv_literata_med_26, .mid = {LITERATA_ARC_MID_LOWER}}};\n')
    (root / 'main/ui/habitat/focus_faces.c').write_text(''.join(c))
    (root / 'main/ui/habitat/focus_faces.h').write_text(''.join(h))
    print(f'total {total} bytes')


if __name__ == '__main__':
    main()
