#!/usr/bin/env python3
"""Tests for scripts/gen_fonts.py (run: python3 test/test_fonts.py)."""
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
        head = re.search(r'ht_pro_%d=\{(\d+),(\d+),(\d+),(\d+),glyphs_%d,alpha_%d\}' % (size, size, size), text)
        assert head, 'ht_pro_%d definition' % size
        fonts[size] = dict(
            header=tuple(int(v) for v in head.groups()),
            glyphs=[tuple(int(v) for v in g) for g in re.findall(r'\{(\d+),(\d+),(\d+)\}', glyphs)],
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
        for size in (24, 32):   # 42 and 56 are sparse: see test_sparse_sizes_have_empty_masks
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
        for size in (42, 56):
            for cp in CODEPOINTS:
                self.assertEqual(ink(fonts[size], cp), cp in map(ord, '#>_?'), 'U+%04X at %d' % (cp, size))

    def test_sparse_sizes_keep_metrics(self):
        sys.path.insert(0, str(PRO / 'scripts'))
        import gen_fonts
        saved, gen_fonts.SPARSE = getattr(gen_fonts, 'SPARSE', {}), {}
        try:
            full = {size: gen_fonts.bake(LIBERATION, size) for size in (42, 56)}
        finally:
            gen_fonts.SPARSE = saved
        fonts = parse(self.out)
        for size, (height, _, glyphs) in full.items():
            self.assertEqual(height, fonts[size]['header'][2])
            self.assertEqual([g[1:] for g in glyphs], [g[1:] for g in fonts[size]['glyphs']], size)

    def test_only_sparse_chars_drawn(self):
        use = re.compile(r'ht_pro_(42|56)\b')
        for path in sorted((PRO / 'main').rglob('*.c')):
            for n, line in enumerate(path.read_text().splitlines(), 1):
                if not use.search(line) or line.lstrip().startswith(('//', '/*', '*')):
                    continue
                where = '%s:%d' % (path.relative_to(PRO), n)
                if path.name == 'pod_pet.c' and re.search(r'fonts\[\]\s*=\s*\{[^}]*&ht_pro_56', line):
                    continue  # the font table in mark_default_big; its only text is ">_"
                if 'ht_pro_text' not in line and 'ht_pro_width' not in line and 'centered(' not in line:
                    self.fail('%s: cannot judge use of ht_pro_42/56: %s' % (where, line.strip()))
                lits = re.findall(r'"((?:[^"\\]|\\.)*)"', line)
                self.assertTrue(lits and all(set(l) <= set('#>_?') for l in lits),
                                '%s: non-sparse text at 42/56: %s' % (where, line.strip()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
