"""Draws Harness Device's icons into src-tauri/icons, with nothing but Python 3, so they are rebuilt from their sources
the same way on any machine.

    python3 device-app/scripts/icons.py tray
        tray.png, tray-light.png and tray-dark.png, from harness-mark.svg (the Harness mark, one path).
    python3 device-app/scripts/icons.py app device-app/src-tauri/icons/app-1024.png
        icon.png (512 px), 32x32.png, 128x128.png and 128x128@2x.png (256 px), from a 1024x1024 PNG.

The app icons are the design team's Harness_AppIcon set, dark variant: icon.icns (Harness_macOS_dark.icns) and
icon.ico (Harness_win_dark.ico) are their files copied as is, and app-1024.png is their Harness_win-linux_dark.png,
which `app` scales down for Linux. For the light variant, copy the set's *_light files over those three and run `app`.
"""
from fractions import Fraction
from itertools import accumulate, chain, repeat
from math import ceil, floor
from operator import add, mul, truediv
from pathlib import Path
import re
import struct
import sys
from xml.etree import ElementTree
import zlib

ICONS = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
MARK = ICONS / "harness-mark.svg"
PNG = b"\x89PNG\r\n\x1a\n"

# name, width, height, RGB, scale, offset. macOS draws a tray icon 18 points tall and keeps its aspect ratio, so the
# template is 44x36 (22x18 points): the mark 40 px wide. Windows and Linux draw one at 16 px (32 at 200 %): the mark
# 32 px wide. Every pixel holds the glyph's colour, even where it is clear, so the files are fully determined.
TRAYS = (
    ("tray.png", 44, 36, (0, 0, 0), 0.2, (2, 6)),  # a macOS template: only its alpha counts
    ("tray-light.png", 32, 32, (255, 255, 255), 0.16, (0, 7)),  # for a dark panel: Windows' dark taskbar, Linux
    ("tray-dark.png", 32, 32, (0x0C, 0x0C, 0x0C), 0.16, (0, 7)),  # for Windows' light taskbar
)
APP = (("icon.png", 512), ("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256))
SOURCE = 1024

SUB_ROWS = 16  # scanlines a pixel row, for anti-aliasing
CURVE_STEPS = 64  # line segments a cubic
TOKEN = r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
ARGS = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "Z": 0}


def polygons_of(d):
    """The closed polygons an SVG path's data draws, its cubics flattened. Only absolute M L H V C Z: anything else
    raises, rather than drawing a wrong mark."""
    if not re.fullmatch(rf"(?:[\s,]|{TOKEN})*", d):
        raise ValueError("path data holds something that is neither a number nor a command")
    tokens = re.findall(TOKEN, d)
    polygons, command, at, closed = [], None, 0, True
    x = y = 0.0
    while at < len(tokens):
        if tokens[at].isalpha():
            command, at = tokens[at], at + 1
            if command not in ARGS:
                raise ValueError(f"path command {command}: only absolute M L H V C Z")
        elif command in (None, "Z"):
            raise ValueError(f"path data: number {tokens[at]} follows no command")
        count = ARGS[command]
        args = tokens[at:at + count]
        if len(args) < count or any(token.isalpha() for token in args):
            raise ValueError(f"path command {command}: wants {count} numbers")
        args, at = [float(token) for token in args], at + count
        if command == "M":
            x, y = args
            polygons.append([(x, y)])
            command, closed = "L", False  # more pairs after an M are line ends
            continue
        if closed:
            raise ValueError(f"path command {command}: no M before it")
        if command == "Z":
            closed = True
            continue
        if command == "C":
            x0, y0 = x, y
            x1, y1, x2, y2, x, y = args
            for step in range(1, CURVE_STEPS + 1):
                t = step / CURVE_STEPS
                u = 1 - t
                polygons[-1].append((u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
                                     u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y))
            continue
        if command == "L":
            x, y = args
        elif command == "H":
            x = args[0]
        else:
            y = args[0]
        polygons[-1].append((x, y))
    return polygons


def coverage(polygons, width, height, scale, offset):
    """Each pixel's share covered by the polygons (nonzero fill), scaled then moved by `offset`, as rows of floats.
    Per scanline the inside spans are exact: a span adds its partial end pixels directly and its whole pixels through
    a difference row, summed once a row, so a long span costs as little as a short one."""
    buckets = [[] for _ in range(height)]
    for polygon in polygons:
        points = [(x * scale + offset[0], y * scale + offset[1]) for x, y in polygon]
        for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
            if y0 != y1:
                for row in range(max(0, floor(min(y0, y1))), min(height, ceil(max(y0, y1)))):
                    buckets[row].append((x0, y0, x1, y1))
    rows = []
    for row, edges in enumerate(buckets):
        part, whole = [0.0] * (width + 1), [0.0] * (width + 1)
        for k in range(SUB_ROWS):
            y = row + (k + 0.5) / SUB_ROWS
            crossings = sorted((x0 + (y - y0) * (x1 - x0) / (y1 - y0), 1 if y1 > y0 else -1)
                               for x0, y0, x1, y1 in edges if min(y0, y1) <= y < max(y0, y1))
            winding = 0
            for (start, direction), (end, _) in zip(crossings, crossings[1:]):
                winding += direction
                start, end = max(start, 0.0), min(end, float(width))
                if not winding or start >= end:
                    continue
                first, last = int(start), int(end)
                if first == last:
                    part[first] += (end - start) / SUB_ROWS
                else:
                    part[first] += (first + 1 - start) / SUB_ROWS
                    whole[first + 1] += 1 / SUB_ROWS
                    whole[last] -= 1 / SUB_ROWS
                    part[last] += (end - last) / SUB_ROWS
        rows.append(list(map(add, accumulate(whole), part))[:width])
    return rows


def encode_png(width, height, rgba):
    """8-bit RGBA, filter 0 on every row, zlib level 9."""
    stride = width * 4
    raw = b"".join(b"\0" + rgba[y * stride:(y + 1) * stride] for y in range(height))

    def chunk(kind, body):
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    return (PNG + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def decode_png(data):
    """(width, height, RGBA bytes) of an 8-bit RGB or RGBA PNG, not interlaced, with no transparent colour (tRNS);
    anything else raises."""
    if data[:8] != PNG:
        raise ValueError("not a PNG")
    at, header, idat = 8, None, bytearray()
    while at + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[at:at + 8])
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", data[at + 8:at + 21])
        elif kind == b"tRNS":
            raise ValueError("PNG: a transparent colour (tRNS): only an RGBA PNG's alpha is read")
        elif kind == b"IDAT":
            idat += data[at + 8:at + 8 + length]
        elif kind == b"IEND":
            break
        at += 12 + length
    if header is None:
        raise ValueError("PNG: no IHDR")
    width, height, depth, colour, compression, method, interlace = header
    if depth != 8 or colour not in (2, 6) or compression or method or interlace:
        raise ValueError(f"PNG: depth {depth}, colour type {colour}, interlace {interlace}: "
                         "only 8-bit RGB or RGBA, not interlaced")
    bpp = 3 if colour == 2 else 4
    stride = width * bpp
    raw = zlib.decompress(bytes(idat))
    if len(raw) != height * (stride + 1):
        raise ValueError("PNG: image data of the wrong length")
    pixels, prior = bytearray(), bytearray(stride)
    for y in range(height):
        kind, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if kind == 1:
            # Each channel is a running sum mod 256, which accumulate does in C.
            for channel in range(bpp):
                line[channel::bpp] = bytes(map((255).__and__, accumulate(line[channel::bpp])))
        elif kind == 2:
            line = bytearray(map(lambda a, b: (a + b) & 255, line, prior))
        elif kind == 3:
            for i in range(bpp):
                line[i] = (line[i] + prior[i] // 2) & 255
            for i in range(bpp, stride):
                line[i] = (line[i] + (line[i - bpp] + prior[i]) // 2) & 255
        elif kind == 4:
            for i in range(bpp):  # nothing to the left: Paeth picks the byte above
                line[i] = (line[i] + prior[i]) & 255
            for i in range(bpp, stride):
                left, up, up_left = line[i - bpp], prior[i], prior[i - bpp]
                pa, pb, pc = abs(up - up_left), abs(left - up_left), abs(left + up - 2 * up_left)
                line[i] = (line[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else up_left)) & 255
        elif kind:
            raise ValueError(f"PNG: filter type {kind}")
        pixels += line
        prior = line
    if bpp == 4:
        return width, height, pixels
    rgba = bytearray(b"\xff") * (width * height * 4)
    for channel in range(3):
        rgba[channel::4] = pixels[channel::3]
    return width, height, rgba


def premultiplied(rgba, side):
    """Rows of (R·A, G·A, B·A, 255·A) per pixel: colour weighted by alpha, so a clear pixel's colour weighs nothing
    when pixels are averaged. A straight colour is then 255 · channel / alpha."""
    rows = []
    for y in range(side):
        row = rgba[y * side * 4:(y + 1) * side * 4]
        weights = bytearray(b"\xff") * len(row)
        for channel in range(3):
            weights[channel::4] = row[3::4]
        rows.append(list(map(mul, row, weights)))
    return rows


def box(rows, size):
    """`rows` resized to `size` rows, each the mean of the source rows it covers, weighted by exact overlap."""
    count = len(rows)
    if size == count:
        return rows
    out, mean = [], float(Fraction(size, count)).__mul__
    for j in range(size):
        start, end = Fraction(j * count, size), Fraction((j + 1) * count, size)
        total = None
        for k in range(floor(start), ceil(end)):
            # A row wholly under the output row is added as it is: only the two end rows need weighing.
            share = min(end, k + 1) - max(start, k)
            row = rows[k] if share == 1 else list(map(float(share).__mul__, rows[k]))
            total = row if total is None else list(map(add, total, row))
        out.append(list(map(mean, total)))
    return out


def transpose(rows):
    """Rows of RGBA pixels turned into columns, each a row of RGBA pixels."""
    pixels = [zip(*[iter(row)] * 4) for row in rows]
    return [list(chain.from_iterable(column)) for column in zip(*pixels)]


def downscale(rows, size):
    """A square of premultiplied rows at `size` px: every pixel the area-weighted mean of the source pixels under it
    (a box filter), done as rows then columns since the weights separate."""
    return transpose(box(transpose(box(rows, size)), size))


def straight(rows):
    """Premultiplied rows as 8-bit straight RGBA, each value rounded once; a clear pixel is all 0."""
    out = bytearray()
    for row in rows:
        alpha = row[3::4]
        safe = list(map(max, alpha, repeat(1e-9)))  # where alpha is 0 so is the colour: 0 over a tiny number
        line = bytearray(len(row))
        for channel in range(3):
            line[channel::4] = bytes(map(round, map(mul, repeat(255.0), map(truediv, row[channel::4], safe))))
        line[3::4] = bytes(map(round, map(truediv, alpha, repeat(255.0))))
        out += line
    return bytes(out)


def mark():
    """The polygons of harness-mark.svg's path."""
    svg = ElementTree.fromstring(MARK.read_text())
    return polygons_of(svg.find("{http://www.w3.org/2000/svg}path").get("d"))


def write_trays(out):
    polygons = mark()
    for name, width, height, rgb, scale, offset in TRAYS:
        rgba = bytearray()
        for row in coverage(polygons, width, height, scale, offset):
            line = bytearray(bytes((*rgb, 0)) * width)
            line[3::4] = bytes(round(255 * min(share, 1.0)) for share in row)
            rgba += line
        (out / name).write_bytes(encode_png(width, height, bytes(rgba)))


def load_source(path):
    """The app icon's source PNG as premultiplied rows; it must be 1024x1024."""
    width, height, rgba = decode_png(Path(path).read_bytes())
    if (width, height) != (SOURCE, SOURCE):
        raise ValueError(f"{Path(path).name} is {width}x{height}: the source is a {SOURCE}x{SOURCE} PNG")
    return premultiplied(rgba, SOURCE)


def write_app(rows, out):
    # Largest first, each from the smallest image made so far whose side it divides: the mean of equal blocks' means
    # is the mean over them all, so it is still the source's area mean, at a fraction of the work. Rounded once, here.
    made = {SOURCE: rows}
    for name, size in sorted(APP, key=lambda app: -app[1]):
        made[size] = downscale(made[min(side for side in made if side % size == 0)], size)
        (out / name).write_bytes(encode_png(size, size, straight(made[size])))


def main(argv):
    try:
        if argv == ["tray"]:
            write_trays(ICONS)
        elif len(argv) == 2 and argv[0] == "app":
            write_app(load_source(argv[1]), ICONS)
        else:
            sys.exit("usage: icons.py tray | icons.py app <source.png>")
    except ValueError as error:
        sys.exit(f"icons.py: {error}")


if __name__ == "__main__":
    main(sys.argv[1:])
