#!/usr/bin/env python3
"""Build the two Google Play listing graphics from `assets/app_icon.svg`.

    python3 scripts/build_play_graphics.py

Writes, into `store/google-play/`:

  * `icon-512.png` — the Play Store icon, 512x512, 32-bit and opaque. Full-bleed and
    square: Play draws its own rounded mask over it, and a rounding baked into
    the file would show as a second, smaller corner inside Play's.
  * `feature-graphic-1024x500.png` — the banner above the listing, 1024x500,
    no alpha (Play refuses one). The logo and the name, nothing near the edges:
    Play crops and overlays that banner differently on every surface.

Needs Pillow and a macOS `swift`, like `build_app_icons.py`, whose square master
this reuses — so the Play icon is the same drawing the launcher slots are, not
a second rendering of the art that could drift from them.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from build_app_icons import RENDERER, master_svg

MOBILE = Path(__file__).resolve().parent.parent
REPO = MOBILE.parent
OUT = MOBILE / "store" / "google-play"

APP_NAME = "Harness"
# The App Store subtitle (`RELEASE.md`), so both stores say the same thing.
TAGLINE = "Your coding agents, anywhere"

# Geist — the brand face the dial draws its whole UI in.
FONTS = REPO / "devices" / "harness-device" / "firmware" / "fonts"
FONT_NAME = FONTS / "Geist-SemiBold.ttf"
FONT_TAGLINE = FONTS / "Geist-Regular.ttf"

BACKGROUND = (10, 10, 10)
INK = (250, 250, 250)
INK_MUTED = (163, 163, 163)
GLOW = (86, 255, 64)  # the tile's top stop

MASTER = 2048
# Everything is drawn at this multiple and resampled down once, so edges and
# glyphs come out antialiased rather than stair-stepped.
SUPERSAMPLE = 2


def render_master(workdir: Path) -> Image.Image:
    """The icon as a full-bleed square, as the launcher slots start from."""
    svg = workdir / "master.svg"
    png = workdir / "master.png"
    svg.write_text(master_svg(MASTER))
    subprocess.run(
        ["swift", str(RENDERER), str(svg), str(png), str(MASTER)], check=True
    )
    return Image.open(png).convert("RGB")


def build_icon(master: Image.Image) -> Image.Image:
    # RGBA although every pixel is opaque: Play asks for a 32-bit PNG here —
    # unlike the feature graphic, which it refuses WITH an alpha channel.
    return master.resize((512, 512), Image.LANCZOS).convert("RGBA")


def rounded(image: Image.Image, radius_ratio: float) -> Image.Image:
    """[image] with Android's launcher rounding, for where it sits on a banner."""
    size = image.width
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    out = image.convert("RGBA")
    out.putalpha(mask)
    return out


def build_feature_graphic(master: Image.Image) -> Image.Image:
    s = SUPERSAMPLE
    width, height = 1024 * s, 500 * s
    canvas = Image.new("RGB", (width, height), BACKGROUND)

    icon_size = 260 * s
    name_font = ImageFont.truetype(str(FONT_NAME), 118 * s)
    tagline_font = ImageFont.truetype(str(FONT_TAGLINE), 36 * s)
    draw = ImageDraw.Draw(canvas)
    name_box = draw.textbbox((0, 0), APP_NAME, font=name_font)
    tagline_box = draw.textbbox((0, 0), TAGLINE, font=tagline_font)
    text_width = max(name_box[2], tagline_box[2])

    # Icon and words centred as ONE block, so the banner holds together under
    # whatever crop a Play surface applies.
    gap = 56 * s
    left = (width - (icon_size + gap + text_width)) // 2
    icon_top = (height - icon_size) // 2

    # A soft green light behind the tile — the icon's own colour, lifted off
    # the dark ground rather than pasted onto it.
    glow = Image.new("L", (width, height), 0)
    pad = 40 * s
    ImageDraw.Draw(glow).ellipse(
        (left - pad, icon_top - pad, left + icon_size + pad, icon_top + icon_size + pad),
        fill=90,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(70 * s))
    canvas.paste(Image.new("RGB", (width, height), GLOW), (0, 0), glow)

    tile = rounded(master.resize((icon_size, icon_size), Image.LANCZOS), 0.22)
    canvas.paste(tile, (left, icon_top), tile)

    # The name and the line under it, set as a block beside the tile.
    text_left = left + icon_size + gap
    name_height = name_box[3] - name_box[1]
    tagline_height = tagline_box[3] - tagline_box[1]
    line_gap = 22 * s
    block_top = (height - (name_height + line_gap + tagline_height)) // 2
    draw = ImageDraw.Draw(canvas)
    draw.text(
        (text_left, block_top - name_box[1]), APP_NAME, font=name_font, fill=INK
    )
    draw.text(
        (text_left, block_top + name_height + line_gap - tagline_box[1]),
        TAGLINE,
        font=tagline_font,
        fill=INK_MUTED,
    )
    return canvas.resize((1024, 500), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        master = render_master(Path(tmp))
    icon = OUT / "icon-512.png"
    feature = OUT / "feature-graphic-1024x500.png"
    build_icon(master).save(icon, optimize=True)
    build_feature_graphic(master).save(feature, optimize=True)
    for path in (icon, feature):
        with Image.open(path) as image:
            print(f"{path.relative_to(MOBILE)}  {image.size[0]}x{image.size[1]} "
                  f"{image.mode}  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
