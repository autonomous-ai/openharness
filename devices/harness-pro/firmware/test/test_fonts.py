#!/usr/bin/env python3
"""Tests for scripts/gen_fonts.py (run: python3 test/test_fonts.py)."""
import math
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PRO = Path(__file__).resolve().parents[1]
GEN = PRO / 'scripts' / 'gen_fonts.py'
LIBERATION = PRO / 'fonts' / 'LiberationSans-Regular.ttf'
HELVETICA = Path('/System/Library/Fonts/Helvetica.ttc')
# The older Pod build's baked pro_fonts.c, when you have one: PRO_FONTS_REFERENCE=/path/to/pro_fonts.c. Without it
# the two comparisons against it are skipped.
_REF = os.environ.get('PRO_FONTS_REFERENCE')
SRCGEN = Path(_REF) if _REF else Path('/nonexistent/pro_fonts.c')
SIZES = (24, 32, 42, 56)
HEIGHTS = {24: 33, 32: 44, 42: 58, 56: 77}  # ceil(size * 1.375), the line cell height
# Vietnamese precomposed letters then the 12 outside that block, after Latin-1.
VIET = list(range(0x1ea0, 0x1efa)) + [0x102, 0x103, 0x110, 0x111, 0x128, 0x129,
                                      0x168, 0x169, 0x1a0, 0x1a1, 0x1af, 0x1b0]
CODEPOINTS = list(range(32, 256)) + VIET


# {offset,width,advance,top,rows}; the older reference file has only the first three.
GLYPH = re.compile(r'\{(\d+),(\d+),(\d+)(?:,(\d+),(\d+))?\}')


def generate(font, out):
    return subprocess.run([sys.executable, str(GEN), '--font', str(font), '--out', str(out)],
                          capture_output=True, text=True, cwd=PRO)


def parse(path):
    """Return {size: dict(header, glyphs, alpha)} from a pro_fonts.c file."""
    text = Path(path).read_text()
    fonts = {}
    for size in SIZES:
        alpha = re.search(r'alpha_%d\[\]=\{(.*?)\};' % size, text, re.S).group(1)
        glyphs = re.search(r'glyphs_%d\[\]=\{(.*?)\};' % size, text, re.S).group(1)
        head = re.search(r'ht_pro_%d=\{(\d+),(\d+),(\d+),(\d+),glyphs_%d,alpha_%d,0,0\}' % (size, size, size), text)
        assert head, 'ht_pro_%d definition' % size
        fonts[size] = dict(
            header=tuple(int(v) for v in head.groups()),
            glyphs=[tuple(int(v) for v in g[:3]) for g in GLYPH.findall(glyphs)],
            alpha=bytes(int(v) for v in alpha.replace('\n', '').strip(',').split(',')),
        )
    return fonts


def ink(font, cp):
    off, width, _ = font['glyphs'][CODEPOINTS.index(cp)]
    n = (width * font['header'][2] + 1) // 2
    return any(font['alpha'][off:off + n])


class FontTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / 'pro_fonts.c'
        cls.run_ = generate(LIBERATION, cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_generates(self):
        self.assertEqual(self.run_.returncode, 0, self.run_.stderr)
        self.assertTrue(self.out.exists())

    def test_symbols(self):
        text = self.out.read_text()
        for size in SIZES:
            self.assertRegex(text, r'const ht_pro_font_t ht_pro_%d=' % size)

    def test_heights(self):
        fonts = parse(self.out)
        for size in SIZES:
            first, last, height, count = fonts[size]['header'][:4]
            self.assertEqual((first, last, height, count), (32, 255, HEIGHTS[size], len(CODEPOINTS)))
            self.assertEqual(len(fonts[size]['glyphs']), len(CODEPOINTS))

    def test_no_helvetica(self):
        self.assertNotIn('helvetica', self.out.read_text().lower())

    def test_codepoints_have_ink(self):
        fonts = parse(self.out)
        for size in (24,):   # 32, 42 and 56 are sparse: see test_sparse_sizes_have_empty_masks
            for cp in [ord('A'), ord('g'), 0xB7] + VIET:
                self.assertTrue(ink(fonts[size], cp), 'U+%04X at %d' % (cp, size))

    @unittest.skipUnless(SRCGEN.exists(), 'reference pro_fonts.c missing')
    def test_covers_reference(self):
        ref, got = parse(SRCGEN), parse(self.out)
        for size in SIZES:
            self.assertEqual(ref[size]['header'], got[size]['header'])
            for cp in CODEPOINTS:
                if ink(ref[size], cp):
                    self.assertTrue(ink(got[size], cp), 'U+%04X at %d' % (cp, size))

    @unittest.skipUnless(HELVETICA.exists() and SRCGEN.exists(), 'Helvetica or reference missing')
    def test_helvetica_matches_reference(self):
        out = Path(self.tmp.name) / 'helv.c'
        r = generate(HELVETICA, out)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn('helvetica', out.read_text().lower())
        ref, got = parse(SRCGEN), parse(out)
        for size in SIZES:
            self.assertEqual(ref[size]['header'], got[size]['header'])
            self.assertEqual(ref[size]['glyphs'], got[size]['glyphs'])
            self.assertEqual(ref[size]['alpha'], got[size]['alpha'])

    def test_sparse_sizes_have_empty_masks(self):
        fonts = parse(self.out)
        sys.path.insert(0, str(PRO / 'scripts'))
        import gen_fonts
        for size in (32, 42, 56):
            for cp in CODEPOINTS:
                self.assertEqual(ink(fonts[size], cp), cp in map(ord, gen_fonts.SPARSE[size]), 'U+%04X at %d' % (cp, size))

    def test_sparse_sizes_keep_metrics(self):
        sys.path.insert(0, str(PRO / 'scripts'))
        import gen_fonts
        saved, gen_fonts.SPARSE = getattr(gen_fonts, 'SPARSE', {}), {}
        try:
            full = {size: gen_fonts.bake(LIBERATION, size) for size in (32, 42, 56)}
        finally:
            gen_fonts.SPARSE = saved
        fonts = parse(self.out)
        for size, (height, _, glyphs) in full.items():
            self.assertEqual(height, fonts[size]['header'][2])
            self.assertEqual([g[1:3] for g in glyphs], [g[1:] for g in fonts[size]['glyphs']], size)

    def test_only_sparse_chars_drawn(self):
        use = re.compile(r'ht_pro_(32|42|56)\b')
        for path in sorted((PRO / 'main').rglob('*.c')):
            for n, line in enumerate(path.read_text().splitlines(), 1):
                if not use.search(line) or line.lstrip().startswith(('//', '/*', '*')):
                    continue
                where = '%s:%d' % (path.relative_to(PRO), n)
                if path.name == 'pod_pet.c' and re.search(r'fonts\[\]\s*=\s*\{[^}]*&ht_pro_56', line):
                    continue  # the font table in pod_mark_default_big; its only text is ">_"
                if 'ht_pro_text' not in line and 'ht_pro_width' not in line and 'centered(' not in line:
                    self.fail('%s: cannot judge use of ht_pro_32/42/56: %s' % (where, line.strip()))
                lits = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
                self.assertTrue(lits and all(set(l) <= set('#>_?') for l in lits),
                                '%s: non-sparse text at 32/42/56: %s' % (where, line.strip()))


CS = {'ph_sb_48': ('Inter-SemiBold', 48), 'ph_sb_34': ('Inter-SemiBold', 34), 'ph_sb_26': ('Inter-SemiBold', 26),
      'ph_sb_22': ('Inter-SemiBold', 22), 'ph_rg_24': ('Inter-Regular', 24), 'ph_mono_26': ('JetBrainsMono-Medium', 26),
      'ph_mono_18': ('JetBrainsMono-Medium', 18), 'ph_sb_32': ('Inter-SemiBold', 32), 'ph_rg_36': ('Inter-Regular', 36),
      'ph_mono_22': ('JetBrainsMono-Medium', 22), 'ph_rg_28': ('Inter-Regular', 28),
      'ph_num_230': ('Inter-SemiBold', 230),
      'ph_bd_84': ('Inter-Bold', 84)}   # Home's cover-card counts: digits only


def parse_cs(text, name):
    alpha = re.search(r'alpha_%s\[\]=\{(.*?)\};' % name, text, re.S).group(1)
    glyphs = re.search(r'glyphs_%s\[\]=\{(.*?)\};' % name, text, re.S).group(1)
    head = re.search(r'%s=\{(\d+),(\d+),(\d+),(\d+),glyphs_%s,alpha_%s,(?:0,0|extras_%s,(\d+))\}' % (name, name, name, name), text)
    assert head, name
    tag = name.removeprefix('ht_pro_')
    table = re.search(r'extras_%s\[\]=\{(.*?)\};' % tag, text)
    extras = [int(v, 16) for v in table.group(1).split(',')] if table else []
    assert len(extras) == int(head.group(5) or 0), name
    return dict(header=tuple(int(v) for v in head.groups()[:4]), extras=extras,
                glyphs=[tuple(int(v) for v in g) for g in GLYPH.findall(glyphs)],
                alpha=bytes(int(v) for v in alpha.replace('\n', '').strip(',').split(',')))


def ink_cs(font, cp):
    off, width, _, _, rows = font['glyphs'][CODEPOINTS.index(cp)]
    return any(font['alpha'][off:off + (width * rows + 1) // 2])


class ConsoleFontTests(unittest.TestCase):
    """The Pets faces always come from fonts/, whatever --font says."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / 'pro_fonts.c'
        assert generate(LIBERATION, cls.out).returncode == 0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_ph_symbols(self):
        text = self.out.read_text()
        total, sizes = 0, []
        for name, (_, size) in CS.items():
            f = parse_cs(text, name)
            total += len(f['alpha'])
            sizes.append('%s %d' % (name, len(f['alpha'])))
            height = f['header'][2]
            self.assertLessEqual(abs(height - size * 1.375), 1, name)   # the cell is ceil(size * 1.375)
            self.assertEqual(len(f['glyphs']), len(CODEPOINTS) + 9, name)   # same table shape, plus the 9 marks
            # a few faces keep only what their view draws (gen_fonts.CONSOLE_CUT); every other face is full
            cut = {'ph_sb_48': '0123456789.-+_% abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 'ph_num_230': '0123456789', 'ph_bd_84': 'Harness0123456789'}
            if name == 'ph_sb_48':   # a cut long version ends in the ellipsis
                off, width, _, _, rows = f['glyphs'][len(CODEPOINTS)]
                self.assertTrue(any(f['alpha'][off:off + (width * rows + 1) // 2]), 'ph_sb_48 U+2026')
            for cp in ([ord(c) for c in cut[name]] if name in cut else [ord('A')] + [ord(c) for c in 'ạốữ']):
                self.assertTrue(ink_cs(f, cp) or cp == 32, '%s U+%04X' % (name, cp))
        print('console font total: %d bytes (%s)' % (total, ', '.join(sizes)))
        # Only the faces the Pets views draw are baked; ph_num_230 (Home's numerals) is about 125 KB of it. Flash is plentiful: the cap is 900 KB.
        self.assertLessEqual(total, 900 * 1000)

    def test_ph_marks_have_ink(self):
        # the marks the chrome draws (the ← replaces ⇠, which no face carries); order is CONSOLE_EXTRA, the face's extras table
        marks = [0x2026, 0x2192, 0x2191, 0x2193, 0x2190, 0x21e2, 0x25b2, 0x25c6, 0x2713]
        text = self.out.read_text()
        for name in CS:
            if name in ('ph_sb_48', 'ph_num_230', 'ph_bd_84'): continue   # cut to what their view draws (gen_fonts.CONSOLE_CUT)
            f = parse_cs(text, name)
            for i, cp in enumerate(marks):
                if cp == 0x21e2: continue
                off, width, _, _, rows = f['glyphs'][len(CODEPOINTS) + i]
                self.assertTrue(any(f['alpha'][off:off + (width * rows + 1) // 2]), '%s U+%04X' % (name, cp))

    def test_ph_independent_of_font(self):
        out = Path(self.tmp.name) / 'other.c'
        helv = HELVETICA if HELVETICA.exists() else LIBERATION
        self.assertEqual(generate(helv, out).returncode, 0)
        a, b = self.out.read_text(), out.read_text()
        for name in CS:
            self.assertEqual(parse_cs(a, name)['alpha'], parse_cs(b, name)['alpha'])


CONSOLE_MARKS = [0x2026, 0x2192, 0x2191, 0x2193, 0x2190, 0x21e2, 0x25b2, 0x25c6, 0x2713]


class ExtrasTableTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name) / 'pro_fonts.c'
        assert generate(LIBERATION, cls.out).returncode == 0
        cls.text = cls.out.read_text()

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_extras_tables(self):
        # every Pets face lists the marks baked after the Vietnamese entries; the base faces list none
        for name in CS:
            self.assertEqual(parse_cs(self.text, name)['extras'], CONSOLE_MARKS, name)
        for size in SIZES:
            self.assertRegex(self.text, r'ht_pro_%d=\{32,255,\d+,326,glyphs_%d,alpha_%d,0,0\}' % (size, size, size))

    def test_no_classic_faces(self):
        self.assertNotIn('ci_rg_', self.text)
        self.assertNotIn('ci_bd_', self.text)


if __name__ == '__main__':
    unittest.main(verbosity=2)
