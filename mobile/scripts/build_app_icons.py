#!/usr/bin/env python3
"""Rebuild every app-icon slot from `assets/app_icon.svg`.

    python3 scripts/build_app_icons.py          # write the icons
    python3 scripts/build_app_icons.py --check   # verify only, write nothing

Needs Pillow (`pip install Pillow`) and a macOS `swift` for `render_svg.swift`.

WHY A SCRIPT. The 21 slots were last rebuilt by hand from a raster source, and
the commit that did it had to explain a flood fill, a least-squares gradient fit
and a per-slot mask reuse to justify the result. None of that is repeatable, and
none of it can be re-run when the art changes. The art is a vector now, so the
whole set is one deterministic pass over it.

THREE RULES THE SLOTS DO NOT SHARE, each a platform's and not a taste:

  * **iOS carries no alpha.** App Store Connect rejects an icon that does, so
    these are flattened to RGB and drawn square — iOS applies its own squircle
    and would fight a rounding baked into the file.

  * **Android and `assets/app_icon.png` keep the alpha they already had.** Their
    masks are reused pixel for pixel rather than redrawn from a guessed radius,
    so new art drops into the geometry the project already shipped and a diff of
    the alpha channel is empty. `assets/app_icon.png` is the in-app logo, drawn
    by `login_screen` and `bootstrapping_screen` with no `ClipRRect` — its
    corners have to be in the file.

  * **The mark is inset, the background is not.** See [TILE].
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

MOBILE = Path(__file__).resolve().parent.parent
SOURCE = MOBILE / "assets" / "app_icon.svg"
RENDERER = MOBILE / "scripts" / "render_svg.swift"

IOS_SET = MOBILE / "ios/Runner/Assets.xcassets/AppIcon.appiconset"
ANDROID_RES = MOBILE / "android/app/src/main/res"
ANDROID_DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
IN_APP_LOGO = MOBILE / "assets" / "app_icon.png"

# How much of the canvas the artwork's own 400x400 tile is given, the rest
# being background the gradient runs on through.
#
# ⚠️ **Measured off the icon this replaces, not chosen.** The mark in the
# shipping 1024 icon spans 0.906 of the canvas and centres at y=493; the tile at
# this fraction reproduces both to a pixel, so the new art lands exactly where
# the old art sat and the change is the drawing alone.
#
# ⚠️ **It is also the clearance the masks need.** The source is drawn to its own
# edges — full-bleed at 1024 the circle's top sits ON row 0, and the guide
# square's bottom corners clear the iOS corner arc by 2.7px. Neither is a cut,
# and both are close enough that the real squircle (which is not this circular
# -cornered approximation) is a coin toss. At this fraction the mark keeps 48px
# of room at 1024. See [CLEARANCE], which is what actually holds the line.
TILE = 0.938

# How far inside the mask the art has to stay, as a fraction of the canvas —
# not merely inside it. Every icon here passes "nothing is cut" even drawn to
# the edges, so that test alone would have let art through that touches the rim
# and reads as clipped on a phone whether or not a pixel was lost.
CLEARANCE = 0.015

# The master every slot is resampled from. Supersampled on purpose: a 2.2px
# stroke on a 400 tile is a third of a pixel at the 20pt slot, and downsampling
# a large render keeps it as a grey line where rasterising straight to 20px
# drops it.
MASTER = 2048

# iOS masks with a superellipse; a circular-cornered rounded rect at Apple's
# published 22.37% corner radius is a slightly TIGHTER shape than the real
# squircle, so content that clears this clears the real one.
IOS_CORNER = 0.2237


def read_source() -> tuple[str, str, str]:
    """The mark (circle, guide square, figure) and the tile's two gradient stops.

    The tile's own rounded rect is dropped: the background below is what fills
    the canvas, and two gradients over different spans would band where they met.
    """
    svg = SOURCE.read_text()
    body = re.search(r"<g clip-path=[^>]*>(.*?)</g>", svg, re.S)
    stops = re.findall(r'<stop[^>]*stop-color="(#[0-9A-Fa-f]{6})"', svg)
    if body is None or len(stops) != 2:
        sys.exit(f"{SOURCE} is not the shape this script knows how to read")
    mark = re.sub(r"<rect width=\"400\" height=\"400\"[^>]*/>\s*", "", body.group(1))
    if "<circle" not in mark or "<path" not in mark:
        sys.exit(f"{SOURCE}: no mark left after dropping the tile")
    return mark.strip(), stops[0], stops[1]


def master_svg(size: int) -> str:
    """The icon as a square: gradient edge to edge, the mark inset by [TILE]."""
    mark, top, bottom = read_source()
    scale = TILE * size / 400
    offset = (1 - TILE) / 2 * size
    return (
        f'<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" '
        'fill="none" xmlns="http://www.w3.org/2000/svg">\n'
        "<defs>\n"
        '<linearGradient id="tile" x1="0" y1="0" '
        f'x2="0" y2="{size}" gradientUnits="userSpaceOnUse">\n'
        f'<stop stop-color="{top}"/>\n'
        f'<stop offset="1" stop-color="{bottom}"/>\n'
        "</linearGradient>\n"
        "</defs>\n"
        f'<rect width="{size}" height="{size}" fill="url(#tile)"/>\n'
        f'<g transform="translate({offset:.4f} {offset:.4f}) scale({scale:.6f})">\n'
        f"{mark}\n"
        "</g>\n"
        "</svg>\n"
    )


def render_master() -> Image.Image:
    with tempfile.TemporaryDirectory() as tmp:
        svg = Path(tmp) / "master.svg"
        png = Path(tmp) / "master.png"
        svg.write_text(master_svg(MASTER))
        subprocess.run(
            ["swift", str(RENDERER), str(svg), str(png), str(MASTER)],
            check=True,
            capture_output=True,
        )
        return Image.open(png).convert("RGBA").copy()


def resample(master: Image.Image, size: int) -> Image.Image:
    return master.resize((size, size), Image.LANCZOS)


def ink(image: Image.Image) -> Image.Image:
    """The drawn mark alone: everything clearly darker than the green field.

    A threshold on luminance is enough because nothing in between is used — the
    field is a bright gradient and the mark is very nearly black.

    ⚠️ **Transparent pixels are not ink**, and saying so is not pedantry: a
    cleared pixel is (0,0,0,0), which drops to black the moment alpha is
    discarded, and without this every corner the mask already cut would be
    counted as art the mask cut.
    """
    dark = Image.eval(image.convert("RGB").convert("L"), lambda v: 255 if v < 110 else 0)
    if "A" not in image.getbands():
        return dark

    from PIL import ImageChops

    opaque = Image.eval(image.getchannel("A"), lambda v: 255 if v >= 128 else 0)
    return ImageChops.multiply(dark, opaque)


def rounded_mask(size: int, radius: float, inset: float = 0) -> Image.Image:
    """A rounded square at 4x, downsampled — the corners have to be smooth.

    [inset] pulls every edge in by that many pixels and takes the same off the
    radius, which is the shape a clearance is measured against.
    """
    scale = 4
    mask = Image.new("L", (size * scale, size * scale), 0)
    from PIL import ImageDraw

    edge = inset * scale
    ImageDraw.Draw(mask).rounded_rectangle(
        (edge, edge, size * scale - 1 - edge, size * scale - 1 - edge),
        radius=max(0.0, (radius - inset) * scale),
        fill=255,
    )
    return mask.resize((size, size), Image.LANCZOS)


def clipped(art: Image.Image, mask: Image.Image) -> int:
    """How many ink pixels the mask would cut. Zero is the only passing answer."""
    marked = ink(art)
    outside = Image.eval(mask, lambda v: 255 if v < 128 else 0)
    from PIL import ImageChops

    return sum(ImageChops.multiply(marked, outside).point(lambda v: v > 0).getdata())


def ios_slots() -> dict[str, int]:
    """Every file Contents.json names, with the pixel size it must be."""
    contents = json.loads((IOS_SET / "Contents.json").read_text())
    slots: dict[str, int] = {}
    for entry in contents["images"]:
        side = float(entry["size"].split("x")[0])
        pixels = round(side * float(entry["scale"].rstrip("x")))
        name = entry["filename"]
        if slots.setdefault(name, pixels) != pixels:
            sys.exit(f"{name} is asked for at two different sizes")
    return slots


def build(check: bool) -> int:
    master = render_master()
    failures: list[str] = []

    def verify(label: str, art: Image.Image, mask: Image.Image) -> None:
        cut = clipped(art, mask)
        if cut:
            failures.append(f"{label}: {cut} ink pixels outside its mask")

    def verify_clearance(label: str, art: Image.Image, size: int) -> None:
        """iOS only: inside the squircle is not enough — see [CLEARANCE]."""
        mask = rounded_mask(size, IOS_CORNER * size, inset=CLEARANCE * size)
        close = clipped(art, mask)
        if close:
            failures.append(f"{label}: {close} ink pixels inside the rim")

    # iOS — square, opaque, and checked against the squircle it will be cut by.
    for name, size in sorted(ios_slots().items(), key=lambda kv: kv[1]):
        art = resample(master, size).convert("RGB")
        verify(f"ios/{name}", art, rounded_mask(size, IOS_CORNER * size))
        verify_clearance(f"ios/{name}", art, size)
        if not check:
            art.save(IOS_SET / name)

    # Android — the alpha each file already had, reused pixel for pixel.
    for density in ANDROID_DENSITIES:
        path = ANDROID_RES / f"mipmap-{density}" / "ic_launcher.png"
        previous = Image.open(path).convert("RGBA")
        art = resample(master, previous.width)
        art.putalpha(previous.getchannel("A"))
        verify(f"android/{density}", art, previous.getchannel("A"))
        if not check:
            art.save(path)

    # The in-app logo — its mask insets before it rounds, so the tile is drawn
    # into the box the alpha actually covers rather than full-bleed and cropped.
    previous = Image.open(IN_APP_LOGO).convert("RGBA")
    alpha = previous.getchannel("A")
    box = alpha.getbbox()
    logo = Image.new("RGBA", previous.size, (0, 0, 0, 0))
    logo.paste(resample(master, box[2] - box[0]), (box[0], box[1]))
    logo.putalpha(alpha)
    verify("assets/app_icon.png", logo, alpha)
    if not check:
        logo.save(IN_APP_LOGO)

    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    if failures:
        return 1
    print(f"{'checked' if check else 'wrote'} {len(ios_slots())} iOS slots, "
          f"{len(ANDROID_DENSITIES)} Android densities and the in-app logo")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify, write nothing")
    sys.exit(build(parser.parse_args().check))
