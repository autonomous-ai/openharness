#!/usr/bin/env python3
"""Bake all ten illustrated daemons and every egg into deterministic desktop PNG assets.

Run from any working directory: python3 daemons/tools/illustrated/generate.py
Only Pillow is required. The local daemon_art.py is the code-authored source;
no temporary-directory source, network service, SVG, font, or bitmap input is
needed. Flutter and AppKit consume PNGs, never this host-side geometry.
"""
from __future__ import annotations

from functools import lru_cache
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

import daemon_art as art
import appearance


ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).resolve().parent
OUT = ROOT / "desktop/assets/daemon-art"
REVIEW = SOURCE / "review"
SIZE = 350
SCALE = art.SCALE

VERSIONS = {"0.1": "baby", "1.0": "young", "2.0": "adult"}
AGES = {"baby": {"scale": .62, "arm_x": .80, "arm_y": .60},
        "young": {"scale": .82, "arm_x": .85, "arm_y": .75},
        "adult": {"scale": 1.0, "arm_x": 1.0, "arm_y": 1.0}}
TIM_COUNTS = {"idle": 4, "work": 4, "need": 4, "done": 4, "fail": 1,
              "nap": 4, "back": 4, "boop": 4, "blink": 1}
TIM_FRAME_MS = {"idle": 190, "work": 140, "need": 190, "done": 90, "fail": 0,
                "nap": 350, "back": 110, "boop": 100, "blink": 120}
EGG_COUNTS = {"p0": 4, "p1": 1, "p2": 1, "p3": 1, "p4": 4,
              "rock": 4, "burst": 4, "tumble": 4, "open": 1, "hatchling": 4}
EGG_FRAME_MS = {"p0": 190, "p1": 0, "p2": 0, "p3": 0, "p4": 190,
                "rock": 130, "burst": 225, "tumble": 150,
                "open": 380, "hatchling": 190}
EGG_KINDS = ("first", "setup", "turn", "week", "marathon", "night", "history", "easter")
EGG_PALETTES = {
    "first": ("#e5ddc6", "#f8f0dc", "#d5c6a7"),
    "setup": ("#ded6d5", "#f4eae2", "#ad9db4"),
    "turn": ("#dedbd0", "#f5f0e3", "#b3ada0"),
    "week": ("#d7dfd2", "#f0f0de", "#8fae9e"),
    "marathon": ("#e6d5bd", "#faf0da", "#c8a27c"),
    "night": ("#d9d5df", "#eeebea", "#9695b2"),
    "history": ("#ded3be", "#f2e9d4", "#b29b76"),
    "easter": ("#e6d6d1", "#f8eade", "#cba3b5"),
}

CRACK = [(0, 190), (88, 196), (110, 184), (130, 200), (151, 184),
         (173, 198), (195, 181), (217, 197), (238, 184), (262, 194), (350, 194)]


def _clear_border(image):
    """No fringe at atlas edges; invisible pixels carry no spare RGB entropy."""
    result = image.convert("RGBA")
    alpha = result.getchannel("A")
    ImageDraw.Draw(alpha).rectangle((0, 0, result.width-1, result.height-1), outline=0, width=1)
    result.putalpha(alpha)
    # A PNG decoder uses straight alpha. Set fully transparent colours to zero
    # without touching antialiased boundary colours.
    blank = Image.new("RGBA", result.size)
    binary = alpha.point(lambda a: 255 if a else 0)
    blank.paste(result, (0, 0), binary)
    return blank


def _affine(image, sx=1., sy=1., dx=0., dy=0., pivot=(170., 315.)):
    if sx == sy == 1 and dx == dy == 0:
        return image.copy()
    px, py = pivot
    return image.transform((SIZE, SIZE), Image.Transform.AFFINE,
                           (1/sx, 0, px-(px+dx)/sx,
                            0, 1/sy, py-(py+dy)/sy),
                           resample=Image.Resampling.BICUBIC)


def _translate(image, dx=0., dy=0.):
    return _affine(image, dx=dx, dy=dy)


def _compose(*layers):
    result = Image.new("RGBA", (SIZE, SIZE))
    for layer in layers:
        result.alpha_composite(layer)
    return result


def render_tim(stage, mood, frame):
    """Preserve Tim's established growth and shell registration."""
    return render_daemon("tim", stage, mood, frame)


def render_daemon(species, stage, mood, frame, material=None):
    """Approved adult shapes, smaller young, and registered expression loops."""
    if species not in art.IDS:
        raise ValueError(species)
    if stage not in AGES or mood not in TIM_COUNTS or not 0 <= frame < TIM_COUNTS[mood]:
        raise ValueError((stage, mood, frame))
    phase = frame*math.tau/4
    fraction = .5-.5*math.cos(phase)
    group, expression = {"idle": (0, "idle"), "work": (2, "working"),
                         "need": (4, "attention"), "done": (6, "done"),
                         "fail": (0, "offline"), "nap": (0, "asleep"),
                         "back": (4, "done"), "boop": (0, "booped"),
                         "blink": (0, "blink")}[mood]
    layers = (art.render_layers(species, pose=group+fraction, expression=expression)
              if material is None else dict(appearance.material_layers(species, group+fraction, expression)[material]))
    growth = AGES[stage]
    scale, arm_x, arm_y = growth["scale"], growth["arm_x"], growth["arm_y"]
    if species == "tim" and stage != "adult":
        # Attachments remain behind the lower head. Compressing the rear layer
        # about those roots gives a hatchling short curls rather than a shrunken
        # adult. The stage's transformed floor is then brought back to y=315.
        layers["rear"] = _affine(layers["rear"], arm_x, arm_y, pivot=(170, 191))
    result = _compose(*layers.values())
    if stage != "adult":
        floor = 191+(315-191)*arm_y if species == "tim" else 315
        result = _affine(result, scale, scale, dy=scale*(315-floor))
    _, sway, hop, squash = appearance.PERSONALITY[species]
    if mood in ("done", "back"):
        bob = (0, -.55, -1, -.4)[frame]*hop*scale
    elif mood == "nap":
        bob = (0, -1, 0, 1)[frame]*scale
    elif mood in ("fail", "blink"):
        bob = 0
    else:
        bob = -1.8*math.sin(phase)*scale
    if bob:
        result = _translate(result, dy=bob)
    if mood not in ("fail", "blink", "nap"):
        result = _translate(result, dx=math.sin(phase)*sway*scale)
    if mood == "boop":
        squeeze = (0, 1, .65, .2)[frame]
        result = _affine(result, 1+.01*squash*squeeze, 1-.012*squash*squeeze)
    return _clear_border(result)


def _shell_shape(c, fill):
    c.shape((175, 65), [((133, 64), (91, 146), (88, 214)),
                        ((84, 276), (111, 315), (174, 316)),
                        ((237, 316), (267, 280), (263, 217)),
                        ((260, 150), (217, 64), (175, 65))], fill)


def _clip(image, mask):
    result = image.copy()
    result.putalpha(ImageChops.multiply(result.getchannel("A"), mask))
    return result


@lru_cache(maxsize=len(EGG_KINDS))
def _shell(kind):
    base, light, mark = EGG_PALETTES[kind]
    c = art.Canvas()
    _shell_shape(c, base)
    c.shape((172, 73), [((138, 74), (104, 145), (101, 207)),
                        ((97, 257), (115, 291), (150, 300)),
                        ((192, 304), (223, 276), (222, 218)),
                        ((222, 164), (209, 82), (172, 73))], light)
    c.ellipse((129, 100, 169, 155), "#fff9eb")
    image = c.finish()
    p = art.Canvas()
    if kind == "setup":
        p.line([(173, 71), (173, 313)], mark, 15)
        p.line([(91, 224), (261, 224)], mark, 14)
        p.shape((172, 215), [((144, 198), (137, 206), (145, 224)),
                              ((152, 232), (166, 224), (172, 221)),
                              ((175, 219), (174, 216), (172, 215))], "#baa9bf")
        p.shape((177, 215), [((205, 198), (212, 206), (204, 224)),
                              ((197, 232), (183, 224), (177, 221)),
                              ((174, 219), (175, 216), (177, 215))], "#baa9bf")
        p.circle(175, 219, 7, "#cfc0d2")
    elif kind == "turn":
        for x, y, r in ((144, 167, 5), (195, 136, 4), (215, 232, 6),
                        (136, 262, 5), (184, 281, 4), (116, 204, 3)):
            p.ellipse((x-r, y-r*.72, x+r, y+r*.72), mark)
    elif kind == "week":
        for x, y, r in ((166, 126, 5), (205, 156, 6), (132, 188, 7),
                        (186, 201, 5), (232, 218, 6), (148, 233, 4),
                        (198, 257, 7), (121, 271, 5), (168, 286, 4)):
            p.ellipse((x-r, y-r*.70, x+r, y+r*.70), mark)
    elif kind == "marathon":
        p.line([(101, 169), (250, 169)], mark, 18)
        p.line([(90, 257), (263, 257)], mark, 18)
    elif kind == "night":
        for x, y, r in ((162, 143, 8), (215, 184, 6), (125, 225, 6),
                        (187, 257, 9), (213, 280, 4)):
            p.shape((x, y-r), [((x+2, y-2), (x+2, y-2), (x+r, y)),
                               ((x+2, y+2), (x+2, y+2), (x, y+r)),
                               ((x-2, y+2), (x-2, y+2), (x-r, y)),
                               ((x-2, y-2), (x-2, y-2), (x, y-r))], mark)
        p.circle(136, 174, 2.5, mark)
        p.circle(229, 247, 2.5, mark)
    elif kind == "history":
        p.line([(89, 232), (263, 232)], mark, 22)
        for x in range(102, 260, 22):
            p.roundrect((x-5, 226, x+5, 237), 2, light)
        p.line([(107, 270), (245, 270)], mark, 3)
    elif kind == "easter":
        for y in (171, 257):
            p.line([(87+i*17, y+(9 if i % 2 else 0)) for i in range(12)], mark, 8)
    image.alpha_composite(_clip(p.finish(), image.getchannel("A")))
    return image


@lru_cache(maxsize=1)
def _halves_masks():
    mask = Image.new("L", (SIZE*SCALE, SIZE*SCALE))
    d = ImageDraw.Draw(mask)
    points = [(0, 0), (SIZE, 0)] + list(reversed(CRACK))
    d.polygon([(int(x*SCALE), int(y*SCALE)) for x, y in points], fill=255)
    mask = mask.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    return mask, ImageChops.invert(mask)


@lru_cache(maxsize=len(EGG_KINDS))
def _halves(kind):
    upper, lower = _halves_masks()
    shell = _shell(kind)
    top, bottom = _clip(shell, upper), _clip(shell, lower)
    edge = art.Canvas()
    edge.line(CRACK[1:-1], "#bbaf99", 3.2)
    line = _clip(edge.finish(), shell.getchannel("A"))
    bottom.alpha_composite(_clip(line, lower))
    top.alpha_composite(_clip(line, upper))
    return top, bottom


def _shadow():
    c = art.Canvas()
    c.ellipse((80, 305, 270, 328), (43, 41, 41, 24))
    return c.finish()


def _rotate(image, angle=0, dx=0, dy=0, pivot=(175, 190)):
    return image.rotate(angle, resample=Image.Resampling.BICUBIC, center=pivot,
                        translate=(dx, dy))


def _interior(glow=False):
    c = art.Canvas()
    c.ellipse((101, 150, 252, 238), "#edd7a5" if glow else "#787080")
    if glow:
        c.ellipse((112, 153, 241, 231), "#fff0c9")
    return c.finish()


def _peek(frame):
    c = art.Canvas()
    for x in (151, 199):
        if frame == 2:
            c.line([(x-7, 181), (x+7, 181)], "#fcf4df", 3.5)
        else:
            c.ellipse((x-9, 169, x+9, 190), "#fcf4df")
            gaze = (0, 2, 0, -2)[frame]
            c.ellipse((x-3+gaze, 173, x+4+gaze, 185), "#393445")
            c.circle(x+2+gaze, 176, 1.7, "#ffffff")
    return c.finish()


def _fallen_halves(top, frame=3):
    left_mask = Image.new("L", (SIZE, SIZE))
    ImageDraw.Draw(left_mask).rectangle((0, 0, 174, SIZE-1), fill=255)
    right_mask = ImageChops.invert(left_mask)
    angle = (20, 42, 64, 80)[frame]
    dx = (4, 6, 8, 10)[frame]
    dy = (-35, -22, 12, 45)[frame]
    left = _rotate(_clip(top, left_mask), angle, -dx, dy)
    right = _rotate(_clip(top, right_mask), -angle, dx, dy)
    return left, right


def render_egg(kind, stage, frame):
    """One warm shell system. No text glyphs and no daemon identity before reveal."""
    if kind not in EGG_KINDS or stage not in EGG_COUNTS or not 0 <= frame < EGG_COUNTS[stage]:
        raise ValueError((kind, stage, frame))
    shell = _shell(kind)
    if stage in ("p0", "p1", "p2"):
        body = shell.copy()
        if stage != "p0":
            crack = art.Canvas()
            crack.line(CRACK[1:6] if stage == "p1" else CRACK[1:-1], "#a99c8c", 3.5)
            if stage == "p2":
                crack.line([(150, 185), (143, 171), (149, 162)], "#a99c8c", 2.6)
                crack.line([(195, 181), (191, 201), (202, 212)], "#a99c8c", 2.6)
                crack.circle(169, 192, 5, "#847888")
            body.alpha_composite(_clip(crack.finish(), shell.getchannel("A")))
        if stage == "p0":
            breath = (1., 1.005, 1.010, 1.003)[frame]
            body = _affine(body, breath, breath, pivot=(175, 315))
        return _clear_border(_compose(_shadow(), body))

    top, bottom = _halves(kind)
    if stage in ("p3", "p4", "rock"):
        lift = 9 if stage == "p3" else 25
        inner = _interior(stage == "p3")
        peeking = _peek(frame) if stage != "p3" else Image.new("RGBA", (SIZE, SIZE))
        upper = _rotate(top, angle=-2 if stage == "p3" else -4, dy=-lift)
        body = _compose(inner, peeking, bottom, upper)
        if stage != "p3":
            angle = (0, -3, 0, 3)[frame] if stage == "p4" else (-7, 0, 8, 0)[frame]
            body = _rotate(body, angle, pivot=(175, 315))
        return _clear_border(_compose(_shadow(), body))

    if stage == "burst":
        ray = art.Canvas()
        reach = (12, 22, 34, 46)[frame]
        for angle in (-145, -115, -65, -35):
            a = math.radians(angle)
            start = (175+math.cos(a)*64, 185+math.sin(a)*38)
            end = (175+math.cos(a)*(64+reach), 185+math.sin(a)*(38+reach))
            ray.line([start, end], (244, 217, 153, 130), 4)
        upper = _rotate(top, angle=-(4+frame*3), dy=-(27+frame*6))
        return _clear_border(_compose(_shadow(), ray.finish(), _interior(True), bottom, upper))

    halves = _fallen_halves(top, frame if stage == "tumble" else 3)
    figure = Image.new("RGBA", (SIZE, SIZE))
    if stage == "hatchling":
        c = art.Canvas()
        bob = (0, -2, 0, 2)[frame]
        # Deliberately species-neutral: a softly rounded silhouette, no arms,
        # ears, colours, beak or other clues to the random hatch result.
        c.ellipse((121, 113+bob, 229, 240+bob), "#b4aab8")
        c.ellipse((131, 121+bob, 215, 225+bob), "#c6bdc7")
        for x in (153, 197):
            if frame == 2:
                c.line([(x-6, 163+bob), (x+6, 163+bob)], "#f5eddf", 3.2)
            else:
                c.ellipse((x-5, 155+bob, x+5, 169+bob), "#f5eddf")
        figure = c.finish()
    chips = art.Canvas()
    if stage != "tumble" or frame >= 2:
        chips.polygon([(51, 310), (59, 299), (66, 313)], EGG_PALETTES[kind][0])
        chips.polygon([(292, 310), (301, 302), (309, 315)], EGG_PALETTES[kind][1])
    return _clear_border(_compose(_shadow(), *halves, figure, bottom, chips.finish()))


def _font(size):
    # Fonts are review-sheet labels only. Runtime art contains no font data.
    for name in ("/System/Library/Fonts/Supplemental/Arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def _contact_sheets():
    REVIEW.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGB", (SIZE*3, 394), "#f2f0e9")
    draw = ImageDraw.Draw(sheet)
    for n, (version, stage) in enumerate(VERSIONS.items()):
        image = render_tim(stage, "idle", 0)
        sheet.paste(image, (n*SIZE, 0), image)
        draw.text((n*SIZE+26, 355), f"Tim / {stage} / {version}", font=_font(18), fill="#445047")
    sheet.save(REVIEW / "tim-growth.png")
    moods = list(TIM_COUNTS)
    sheet = Image.new("RGB", (len(moods)*175, 3*208+35), "#f2f0e9")
    draw = ImageDraw.Draw(sheet)
    for j, mood in enumerate(moods):
        draw.text((j*175+12, 10), mood, font=_font(15), fill="#445047")
    for i, stage in enumerate(AGES):
        for j, mood in enumerate(moods):
            image = render_tim(stage, mood, 0).resize((175, 175), Image.Resampling.LANCZOS)
            sheet.paste(image, (j*175, 32+i*208), image)
        draw.text((12, 210+i*208), stage, font=_font(14), fill="#445047")
    sheet.save(REVIEW / "tim-moods.png")
    egg_stages = list(EGG_COUNTS)
    sheet = Image.new("RGB", (len(egg_stages)*150, len(EGG_KINDS)*176+35), "#f2f0e9")
    draw = ImageDraw.Draw(sheet)
    for j, stage in enumerate(egg_stages):
        draw.text((j*150+12, 9), stage, font=_font(14), fill="#445047")
    for i, kind in enumerate(EGG_KINDS):
        for j, stage in enumerate(egg_stages):
            frame = 3 if stage in ("tumble", "burst") else 0
            image = render_egg(kind, stage, frame).resize((150, 150), Image.Resampling.LANCZOS)
            sheet.paste(image, (j*150, 32+i*176), image)
        draw.text((12, 178+i*176), kind, font=_font(13), fill="#445047")
    sheet.save(REVIEW / "eggs.png")
    # Actual slot pixels on both workspace tones, without scaling them up.
    keys = [f"tim_{stage}_idle_0" for stage in AGES]
    keys += [f"egg_{kind}_p4_0" for kind in EGG_KINDS]
    sheet = Image.new("RGB", (len(keys)*100, 256), "#f2f0e9")
    draw = ImageDraw.Draw(sheet)
    draw.rectangle((0, 128, sheet.width, 256), fill="#26252c")
    for j, key in enumerate(keys):
        image = Image.open(OUT / "slot" / f"{key}.png").convert("RGBA")
        for y, fill in ((12, "#445047"), (140, "#f2f0e9")):
            sheet.paste(image, (j*100+18, y), image)
            label = key.removeprefix("tim_").removeprefix("egg_").rsplit("_", 2)[0]
            draw.text((j*100+7, y+72), label, fill=fill, font=_font(12))
    sheet.save(REVIEW / "slots-light-dark.png")
    # Registration evidence for Flutter's existing hatch state machine: clip
    # the rising figure inside the shell before the front bowl is painted.
    # Without this mask its displaced arms would peek out below the egg.
    sheet = Image.new("RGB", (SIZE*4, 396*2), "#f2f0e9")
    draw = ImageDraw.Draw(sheet)
    inside_shell = Image.new("L", (SIZE, SIZE))
    ImageDraw.Draw(inside_shell).rectangle((88, 0, 264, 200), fill=255)
    for row in range(2):
        for col, progress in enumerate((0, .33, .66, 1)):
            image = render_tim("baby", "idle", 0)
            if row == 0:
                silhouette = Image.new("RGBA", image.size, "#aaa1b1")
                silhouette.putalpha(image.getchannel("A"))
                image = silhouette
            image = _clip(_translate(image, dy=30-120*progress), inside_shell)
            scene = _compose(image, render_egg("first", "open", 0))
            sheet.paste(scene, (col*SIZE, row*396), scene)
            draw.text((col*SIZE+24, row*396+354),
                      f'{"silhouette" if row == 0 else "colour"} / {progress:g}',
                      font=_font(18), fill="#445047")
    sheet.save(REVIEW / "hatch-composition.png")
    for tone, bg, fg in (("light", "#f2f0e9", "#445047"),
                         ("dark", "#26252c", "#f2f0e9")):
        sheet = Image.new("RGB", (5*240, 2*275), bg)
        draw = ImageDraw.Draw(sheet)
        for n, species in enumerate(art.IDS):
            image = render_daemon(species, "adult", "idle", 0)
            image = image.resize((220, 220), Image.Resampling.LANCZOS)
            x, y = (n % 5)*240+10, (n // 5)*275+10
            sheet.paste(image, (x, y), image)
            draw.text((x+12, y+235), art.DISPLAY_NAMES[species], font=_font(18), fill=fg)
        sheet.save(REVIEW / f"all-daemons-{tone}.png")


def _sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    roster_path = ROOT / "daemons/roster.json"
    roster = json.loads(roster_path.read_text())
    assert list(VERSIONS) == roster["rules"]["versions"]
    assert tuple(roster["rules"]["eggs"]) == EGG_KINDS
    assert set(TIM_COUNTS)-{"blink"} == set(roster["rules"]["moods"])
    for directory in (OUT / "slot", OUT / "portrait"):
        directory.mkdir(parents=True, exist_ok=True)
    assets = []

    def save(key, image, family, state):
        files = {}
        for format_name, size in (("slot", 64), ("portrait", 350)):
            im = image if size == SIZE else image.resize((size, size), Image.Resampling.LANCZOS)
            im = _clear_border(im)
            path = OUT / format_name / f"{key}.png"
            im.save(path, optimize=True, compress_level=9)
            # Re-open the delivered file, not just the pre-encoding buffer.
            with Image.open(path) as verified:
                assert verified.mode == "RGBA" and verified.size == (size, size)
                assert verified.tobytes() == im.tobytes()
                alpha = verified.getchannel("A")
                assert alpha.crop((0, 0, size, 1)).getbbox() is None
                assert alpha.crop((0, size-1, size, size)).getbbox() is None
                assert alpha.crop((0, 0, 1, size)).getbbox() is None
                assert alpha.crop((size-1, 0, size, size)).getbbox() is None
                assert alpha.getbbox() is not None
            files[format_name] = {"path": path.relative_to(ROOT / "desktop").as_posix(),
                                  "width": size, "height": size, "bytes": path.stat().st_size,
                                  "sha256": _sha(path), "alpha_bounds": im.getchannel("A").getbbox()}
        assets.append({"key": key, "family": family, **state, "files": files})

    for species in art.IDS:
        for stage in AGES:
            for mood, count in TIM_COUNTS.items():
                for frame in range(count):
                    key=f"{species}_{stage}_{mood}_{frame}"
                    save(key,
                         render_daemon(species, stage, mood, frame),
                         species, {"stage": stage, "mood": mood, "frame": frame})
                    planes=[render_daemon(species,stage,mood,frame,material=i).getchannel('R') for i in range(6)]
                    for suffix,channels in (("material",planes[:3]),("marks",planes[3:])):
                        mask=Image.merge('RGB',channels)
                        for format_name,size in (("slot",64),("portrait",350)):
                            mask.resize((size,size),Image.Resampling.LANCZOS).save(
                                OUT/format_name/f"{key}_{suffix}.png",optimize=True)
    for kind in EGG_KINDS:
        for stage, count in EGG_COUNTS.items():
            for frame in range(count):
                save(f"egg_{kind}_{stage}_{frame}", render_egg(kind, stage, frame),
                     "egg", {"kind": kind, "stage": stage, "frame": frame})
    expected = len(art.IDS)*len(AGES)*sum(TIM_COUNTS.values())+len(EGG_KINDS)*sum(EGG_COUNTS.values())
    assert len(assets) == expected == 1124
    assert len({a["key"] for a in assets}) == len(assets)
    manifest = {
        "version": 2,
        "species": art.IDS,
        "format": "PNG / straight-alpha RGBA / sRGB",
        "description": "Authored illustrations with shared growth, coat materials, named markings and species motion.",
        "geometry": {"slot": [64, 64], "portrait": [350, 350], "floor": 315,
                     "transparent_border": 1, "growth": AGES,
                     "egg_rim_y": [181, 200], "egg_rim_center_y": 198,
                     "egg_floor_y": 316, "hatch_tim_baby_final_dy": -90,
                     "hatch_figure_clip": [88, 0, 264, 200],
                     "peek_eye_bounds": [[142, 169, 160, 190], [190, 169, 208, 190]]},
        "version_stages": VERSIONS,
        "daemon_frame_counts": TIM_COUNTS,
        "daemon_frame_ms": TIM_FRAME_MS,
        "egg_kinds": EGG_KINDS,
        "egg_frame_counts": EGG_COUNTS,
        "egg_frame_ms": EGG_FRAME_MS,
        "opening": {"rock_loops": 2, "burst_first_frame_ms": 420,
                    "order": ["rock", "burst", "tumble", "open"],
                    "hatchling_is_anonymous": True},
        "source_sha256": {p.relative_to(ROOT).as_posix(): _sha(p)
                          for p in (SOURCE / "daemon_art.py", Path(__file__).resolve(), roster_path)},
        "asset_key_count": len(assets),
        "png_count": len(assets)*2,
        "png_bytes": sum(f["bytes"] for a in assets for f in a["files"].values()),
        "bytes_by_size": {size: sum(a["files"][size]["bytes"] for a in assets)
                          for size in ("slot", "portrait")},
        "assets": assets,
    }
    # One idle anchor per species/age or egg kind. Never recenter individual
    # animation frames: jumps and breathing must remain visible. Both consumers
    # use these generated numbers instead of maintaining separate magic offsets.
    centers = {}
    for asset in assets:
        is_idle = asset["family"] != "egg" and asset["mood"] == "idle"
        is_shell = asset["family"] == "egg" and asset["stage"] == "p0"
        if asset["frame"] == 0 and (is_idle or is_shell):
            key = "_".join(asset["key"].split("_")[:2])
            center = []
            for size in ("slot", "portrait"):
                x0, y0, x1, y1 = asset["files"][size]["alpha_bounds"]
                center.extend(((x0+x1)/2, (y0+y1)/2))
            centers[key] = center
    (OUT / "alignment.json").write_text(json.dumps(centers, indent=2)+"\n")
    dart = ["// Generated by daemons/tools/illustrated/generate.py. Do not edit.",
            "const illustratedArtCenters = <String, (double, double, double, double)>{"]
    for key, center in centers.items():
        dart.append(f"  '{key}': ({', '.join(str(v) for v in center)}),")
    dart.append("};")
    (ROOT / "desktop/lib/daemons/illustrated_alignment.g.dart").write_text("\n".join(dart)+"\n")
    styles={species:{'palettes':appearance.palettes(species),
                     'colours':[row[0] for row in appearance.ROSTER[species]['traits']['colours']],
                     'marks':[row[0] for row in appearance.ROSTER[species]['traits']['marks']],
                     'timing':appearance.PERSONALITY[species][0]}
            for species in art.IDS}
    (OUT/'styles.json').write_text(json.dumps(styles,separators=(',',':'))+'\n')
    dart=['// Generated by daemons/tools/illustrated/generate.py. Do not edit.',
          'const illustratedStyles = <String, Map<String, dynamic>>{']
    for species,style in styles.items(): dart.append(f"  '{species}': {json.dumps(style)},")
    dart.append('};')
    (ROOT/'desktop/lib/daemons/illustrated_styles.g.dart').write_text('\n'.join(dart)+'\n')
    materials={p.relative_to(ROOT/'desktop').as_posix(): {'bytes':p.stat().st_size,'sha256':_sha(p)}
               for suffix in ('material','marks') for p in sorted(OUT.glob(f'*/*_{suffix}.png'))}
    manifest['materials']=materials
    manifest['base_png_count']=manifest['png_count']
    manifest['material_png_count']=len(materials)
    manifest['png_count']+=len(materials)
    manifest['png_bytes']+=sum(v['bytes'] for v in materials.values())
    manifest['bytes_by_size']={size:sum(p.stat().st_size for p in (OUT/size).glob('*.png')) for size in ('slot','portrait')}
    manifest['source_sha256']['daemons/tools/illustrated/appearance.py']=_sha(SOURCE/'appearance.py')
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
    _contact_sheets()
    print(json.dumps({k: manifest[k] for k in ("asset_key_count", "png_count", "png_bytes", "bytes_by_size")}, indent=2))
    print("Review sheets:", REVIEW.relative_to(ROOT))


if __name__ == "__main__":
    main()
