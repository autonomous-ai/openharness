"""icons.py: the committed tray PNGs are what it draws from harness-mark.svg, and the committed app PNGs are what it
writes from app-1024.png. Everything it writes goes to temp folders."""
from fractions import Fraction
import importlib.util
from itertools import chain
from pathlib import Path
import random
import struct
import tempfile
import unittest
import zlib

SCRIPT = Path(__file__).resolve().parent / "icons.py"
spec = importlib.util.spec_from_file_location("icons", SCRIPT)
icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(icons)

ICONS = SCRIPT.parent.parent / "src-tauri" / "icons"
TRAYS = {"tray.png": (44, 36), "tray-light.png": (32, 32), "tray-dark.png": (32, 32)}
APP = {"icon.png": 512, "32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256}


def paeth(left, up, up_left):
    p = left + up - up_left
    pa, pb, pc = abs(p - left), abs(p - up), abs(p - up_left)
    return left if pa <= pb and pa <= pc else up if pb <= pc else up_left


def png(width, height, colour, raw_rows, filters, depth=8, interlace=0, extra=()):
    """A PNG of `raw_rows` (unfiltered bytes per row), each row filtered by its entry in `filters`, with the `extra`
    (kind, body) chunks before its data: this test's own encoder, so the decoder is checked against something it did
    not write."""
    bpp = 3 if colour == 2 else 4
    data, prior = bytearray(), bytes(len(raw_rows[0]))
    for row, kind in zip(raw_rows, filters):
        out = bytearray()
        for i, value in enumerate(row):
            left = row[i - bpp] if i >= bpp else 0
            up_left = prior[i - bpp] if i >= bpp else 0
            predictor = [0, left, prior[i], (left + prior[i]) // 2, paeth(left, prior[i], up_left)][kind]
            out.append((value - predictor) & 255)
        data += bytes((kind,)) + out
        prior = row

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", width, height, depth, colour, 0, 0, interlace)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + b"".join(chunk(kind, body) for kind, body in extra)
            + chunk(b"IDAT", zlib.compress(bytes(data), 1)) + chunk(b"IEND", b""))


def decode(data):
    width, height, rgba = icons.decode_png(data)
    return (width, height), bytes(rgba)


class Tray(unittest.TestCase):
    def test_the_committed_tray_pngs_are_what_tray_draws(self):
        with tempfile.TemporaryDirectory() as out:
            icons.write_trays(Path(out))
            for name, size in TRAYS.items():
                committed, drawn = decode((ICONS / name).read_bytes()), decode((Path(out) / name).read_bytes())
                self.assertEqual(committed[0], size, name)
                # Decoded pixels, not bytes: another zlib may compress the same rows differently.
                self.assertEqual(committed, drawn, name)

    def test_the_path_parser_takes_absolute_m_l_h_v_c_z(self):
        self.assertEqual(icons.polygons_of("M0 0 L10 0 V10 H0 Z"), [[(0, 0), (10, 0), (10, 10), (0, 10)]])
        curve = icons.polygons_of("M0 0C0 10 10 10 10 0Z")[0]
        self.assertEqual((curve[0], curve[-1]), ((0, 0), (10, 0)))
        self.assertGreater(len(curve), 8)

    def test_path_data_it_cannot_draw_is_refused(self):
        for d in ("M0 0 l10 0Z", "M0 0 Q1 1 2 0Z", "M0 0 A5 5 0 0 1 10 0", "L1 1", "M0 0 L1", "M0 0 L1 x2"):
            with self.subTest(d=d), self.assertRaises(ValueError):
                icons.polygons_of(d)


class Png(unittest.TestCase):
    def test_the_decoder_reads_every_filter_type(self):
        rng = random.Random(4)
        for colour, bpp in ((2, 3), (6, 4)):
            raw = [bytes(rng.randrange(256) for _ in range(5 * bpp)) for _ in range(5)]
            want = b"".join(bytes(chain.from_iterable(
                (*row[i:i + 3], row[i + 3] if bpp == 4 else 255) for i in range(0, len(row), bpp))) for row in raw)
            for filters in ([0] * 5, [1] * 5, [2] * 5, [3] * 5, [4] * 5, [4, 3, 2, 1, 0]):
                with self.subTest(colour=colour, filters=filters):
                    self.assertEqual(decode(png(5, 5, colour, raw, filters)), ((5, 5), want))

    def test_the_decoder_refuses_what_it_cannot_read(self):
        row = [bytes(8)]
        for name, data in (("16-bit", png(1, 1, 6, row, [0], depth=16)), ("palette", png(2, 1, 3, row, [0])),
                           ("grey", png(2, 1, 0, row, [0])), ("interlaced", png(2, 1, 6, row, [0], interlace=1)),
                           # An RGB image whose tRNS makes one colour clear: read as opaque, its clear pixels would show.
                           ("transparent colour", png(2, 1, 2, [bytes(6)], [0], extra=((b"tRNS", bytes(6)),))),
                           ("not a PNG", b"GIF89a")):
            with self.subTest(name), self.assertRaises(ValueError):
                icons.decode_png(data)


class App(unittest.TestCase):
    def test_a_downscale_is_the_area_weighted_mean_in_premultiplied_alpha(self):
        rng = random.Random(7)
        side = 6
        pixels = [(rng.randrange(256), rng.randrange(256), rng.randrange(256), rng.choice((0, 255, rng.randrange(256))))
                  for _ in range(side * side)]
        rgba = bytes(chain.from_iterable(pixels))

        def overlap(o, i, size):
            return max(Fraction(0), min(Fraction((o + 1) * side, size), i + 1) - max(Fraction(o * side, size), i))

        for size in (6, 5, 4, 3, 2, 1):
            want = []
            for oy in range(size):
                for ox in range(size):
                    total = [Fraction(0)] * 4
                    for i, (r, g, b, a) in enumerate(pixels):
                        w = overlap(ox, i % side, size) * overlap(oy, i // side, size)
                        total = [t + w * v for t, v in zip(total, (r * a, g * a, b * a, a))]
                    a = total[3]
                    want += [round(c / a) if a else 0 for c in total[:3]] + [round(a * size * size / side ** 2)]
            with self.subTest(size=size):
                got = icons.straight(icons.downscale(icons.premultiplied(rgba, side), size))
                self.assertEqual(list(got), want)

    def test_the_committed_app_pngs_are_what_app_writes_from_app_1024(self):
        with tempfile.TemporaryDirectory() as out:
            icons.write_app(icons.load_source(ICONS / "app-1024.png"), Path(out))
            for name, size in APP.items():
                committed, written = decode((ICONS / name).read_bytes()), decode((Path(out) / name).read_bytes())
                self.assertEqual(committed[0], (size, size), name)
                self.assertEqual(committed, written, name)

    def test_a_source_not_1024_px_square_is_refused(self):
        with tempfile.TemporaryDirectory() as out:
            source = Path(out) / "icon.png"
            source.write_bytes(png(16, 8, 6, [bytes(64)] * 8, [0] * 8))
            with self.assertRaisesRegex(ValueError, "16x8.*1024x1024"):
                icons.load_source(source)


if __name__ == "__main__":
    unittest.main()
