#!/usr/bin/env python3
"""The pets on the Focus agent screen: pixel art that stands in for an engine's static mark.

    python3 devices/harness-device/firmware/scripts/gen_pets.py          # write
    python3 devices/harness-device/firmware/scripts/gen_pets.py --check  # fail if stale

Claude Code: Clawd, drawn at the glass's 1 px with anti-aliased edges (assets/pets/claude, exported by
mockup/clawd_v3.py; the look is mockup/clawd-v3.html): the small pet is the rest loop (24 steps of 120 ms, cell
frames like Muse's), three scenes — working 26 steps of 55 ms, listening 56 of 60 (its sound arcs drawn by
focus.c), sending 40 of 60 — each a few body poses moved by a per-step dy, and a props sprite.
Every pet's alert is the same blue bell bubble over its working scene (ALERT_BUBBLES).
Codex: its small pet is the robot pack's idle, review and waiting loops drawn at 2x (mockup/codex-rest.html), and
its three scenes come from the same pack (assets/pets/codex; mockup/codex_options.py W2 / L1 / S2):
the pack's 192 x 208 robot frames at one byte per pixel (cell 1) and, listening and sending, an overlay sprite (the
equalizer bubble, the paper plane) drawn after them: 28 steps of 120 ms, 15 steps of 80 ms for each mic level
0..4, and 15 steps of 140 ms. The listening bubble is stored once, empty; its three bars are not stored at all:
the scene's ht_pet_bars_t (x, centre y, size, fills, 1200 ms sine and phase step from the BAR_* constants) lets
focus.c draw them as rounded boxes at the scene clock, so they move continuously (the old 61 overlay images,
one per level and 80 ms step, cost 197 KB).
Muse Code: Jolly, Meta Muse's mascot, cut from Meta's own render and from Meta's waving clip
(assets/pets/muse, exported by mockup/muse_jolly.py; the look is mockup/muse-jolly.html). The small pet is
eighteen frames of the waving clip cropped to their ink box (two waves, then the arm down and
up: MUSE_REST_SEQ), one 18-step loop for all four states, stored like the scenes
(palette-indexed cell frames at cell 1, <= 255 colours, index 0 transparent: a third of the RGB565 + alpha8
bytes) and drawn with ht_cell_sprite. Its three scenes are
pack scenes like Codex's, from straight-alpha PNG frames at device scale (cell 1): working (headphones, typing
at the laptop) 8 steps of 140 ms, listening 12 steps of 140 ms for every mic level 0..4, and sending (the clip's
throw of a paper plane, the plane and its swoosh an overlay sprite) 13 steps of 166 ms with the last one held.
The listening frames (L2) carry no sound waves: assets/pets/muse/listen.json describes three arcs on each side of
the head (centre, radii, width, span, colour, period) and the scene's ht_pet_waves_t lets focus.c draw them as ring
arcs at the face clock, so they glide and follow the mic level. Poses that mirror each other (step t and 6 - t) are
pixel-identical PNGs and are stored once; the loop indexes them (12 stored frames, 249 KB, before; 8 now).
Each state (idle, working, done, asking) is a loop of 24 steps, each a frame and a vertical offset in
px, on the Pro daemons' clock. Frames are de-duplicated per pet, so the file holds each pose once and
the loops index it. Writes main/ui/habitat/pets.c: each pet's frames, loops and step_ms, and the
registry ht_pets[] / ht_pet_count (declared in pets.h). Frames use the same encoding as
gen_focus_marks.py: RGB565 in panel order plus alpha8 (0 or 255 only).
"""
import json
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageColor, ImageDraw

root = Path(__file__).resolve().parents[1]
STEPS = 24

# ---- Codex: the small pet, from the owner's robot pack (owner, 2026-10-06: the 14 x 14 grid stair-stepped) ----
# The pack's idle (it blinks), review (a happy hop: done) and waiting (hand on chin: asking) loops, assets/pets/codex,
# cropped to one box for all three, drawn once at 2x (112 px tall) and shown at 1x, 1.5x, 1.75x or 2x by
# ht_cell_sprite_zoom (mockup/codex-rest.html). Each state is 24 steps over the pack's own loop and frame times.
CODEX = root / 'assets/pets/codex'
CODEX_H2X = 112
CODEX_LOOPS = {'idle': (280, 110, 110, 140, 140, 320), 'review': (150, 150, 150, 150, 150, 280),
               'waiting': (150, 150, 150, 150, 150, 260)}
CODEX_STATE_LOOPS = ('idle', 'idle', 'review', 'waiting')            # idle, working, done, asking


def codex_pet_states():
    names = list(CODEX_LOOPS)
    raw = [Image.open(CODEX / st / f'{k:02d}.png').convert('RGBA') for st in names for k in range(6)]
    box = union_box(raw)
    images = []
    for f in raw:
        f = f.crop(box)
        f = f.resize((round(f.width * CODEX_H2X / f.height), CODEX_H2X), Image.LANCZOS)
        a = f.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
        im = Image.alpha_composite(Image.new('RGBA', f.size, (0, 0, 0, 255)), f)
        im.putalpha(a)
        images.append(im)
    states, step_ms = [], []
    for st in CODEX_STATE_LOOPS:
        times = CODEX_LOOPS[st]
        each = round(sum(times) / STEPS)
        loop = []
        for i in range(STEPS):
            t, k = i * each, 0
            while k < 5 and t >= sum(times[:k + 1]):
                k += 1
            loop.append(({'i': names.index(st) * 6 + k}, 0))
        states.append(lambda loop=loop: loop)
        step_ms.append(each)
    return tuple(states), images, tuple(step_ms)


def codex_render(cells):
    return CODEX_IMAGES[cells['i']]


def half_size(size):
    """The 1x size of a 2x drawing, as ht_cell_sprite_zoom draws it at zoom 4."""
    return ((size[0] * 4 + 7) // 8, (size[1] * 4 + 7) // 8)


LEVELS = 5                           # pets.h HT_PET_SCENE_LEVELS (a _Static_assert in the output holds them)


# ---- Codex's scenes: the owner's robot pack (assets/pets/codex, 192 x 208 RGBA frames) ----
# Working = the pack's "running" laptop loop, no bubble (owner, 2026-10-07: the notice bell takes its place),
# listening = the wave-only keyframes + a bubble of three bars that follow the mic level (L1, encode.py of
# the pack), sending = the "waving" loop + a paper plane leaving the hand (S2). The robot frames are
# composited over black and quantised per scene (index 0 transparent, cell = 1); the moving bubble or
# plane is a second small sprite, the scene's overlay, drawn after the scene (pets.h ht_pet_overlay_t).
PACK = root / 'assets/pets/codex'
CW, CH = 300, 260                    # the mockup's scene canvas, centred on the glass; the robot sits at RX, RY
RX, RY = (CW - 192) // 2, (CH - 208) // 2 + 6
CX_FILL, CX_LINE, CX_BAR, CX_BAR_HI = '#172d63', '#bceeff', '#74d7ff', '#b6f6ff'
# per scene: pack frames, robot frame per step, step_ms, home-face placement bias (focus.c: working +4, listening -6)
XWORK_STEPS = ([0, 1, 2, 3, 4, 5, 5]) * 4          # running: 120 ms frames, the last one 220 ms = two steps
XWORK_MS, XLISTEN_MS, XSEND_MS = 120, 80, 140
XLISTEN_FRAMES = [0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 3, 3, 3, 3]   # encode.py's keyframes, 60-90 ms rounded to 80
XSEND_STEPS = ([0, 1, 2, 3, 3]) * 3                 # waving: 140 ms frames, the last one 280 ms


def pack_frames(folder, n):
    return [Image.open(PACK / folder / f'{i:02d}.png').convert('RGBA') for i in range(n)]


def canvas():
    return Image.new('RGBA', (CW, CH), (0, 0, 0, 0))


# The listening bubble's three bars are NOT stored: focus.c draws them as rounded boxes (ht_pet_bars_t), from
# these constants (x from the robot canvas's RX, centre y from RY; PIL's rounded_rectangle x0..x0 + 7 is 8 px of ink).
BAR_X = (184, 195, 206)
BAR_W = 7
BAR_CY = 61
BAR_RADIUS = 3
BAR_MIN, BAR_SWING = 9, 19
BAR_PERIOD_MS, BAR_PHASE = 1200, 1.2


def listen_bubble():
    """The listening bubble without its bars (they are drawn in code, see BAR_*)."""
    im = canvas()
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((RX + 171, RY + 37, RX + 226, RY + 85), radius=9, fill=CX_FILL, outline=CX_LINE, width=2)
    d.polygon([(RX + 177, RY + 83), (RX + 168, RY + 91), (RX + 184, RY + 85)], fill=CX_FILL)
    d.line([(RX + 177, RY + 85), (RX + 168, RY + 91), (RX + 180, RY + 86)], fill=CX_LINE, width=2)
    return im


def send_overlay(step, steps):
    """A paper plane leaving the waving hand, up and right, shrinking, with a dotted trail; gone at the end."""
    im = canvas()
    d = ImageDraw.Draw(im)
    t = step / (steps - 1)
    x = RX + 40 - t * 30 + t * t * 230
    y = RY + 70 - t * 95
    s = 1.0 - 0.3 * t
    pts = [(x, y + 10 * s), (x + 30 * s, y), (x + 12 * s, y + 18 * s)]
    if t < 0.95:
        d.polygon(pts, fill=CX_BAR_HI, outline=CX_LINE)
        d.polygon([(x + 12 * s, y + 18 * s), (x + 30 * s, y), (x + 15 * s, y + 11 * s)], fill=CX_BAR)
        for k in range(1, 5):
            tx, ty = x - k * 9 + k * k * 1.5, y + 12 + k * 7
            if k % 2:
                d.ellipse((tx - 2, ty - 2, tx + 2, ty + 2), fill=CX_BAR)
    return im


def quantise_robot(frames, box):
    """The robot frames over black, cropped to `box`, one <= 255 colour palette for the scene: per frame
    a grid of palette indices (1..) with 0 for what is transparent or pure black (the ground is black)."""
    black = Image.new('RGBA', frames[0].size, (0, 0, 0, 255))
    flat = [Image.alpha_composite(black, f).convert('RGB').crop(box) for f in frames]
    strip = Image.new('RGB', (flat[0].width * len(flat), flat[0].height))
    for i, f in enumerate(flat):
        strip.paste(f, (i * f.width, 0))
    pal = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    rgb = pal.getpalette()
    grids, used = [], {}
    for f, src in zip(flat, frames):
        q = f.quantize(palette=pal, dither=Image.Dither.NONE)
        alpha = src.crop(box).getchannel('A')
        grid = []
        for qv, a, px in zip(q.get_flattened_data(), alpha.get_flattened_data(), f.get_flattened_data()):
            if not a or px == (0, 0, 0):
                grid.append(0)
                continue
            used.setdefault(qv, len(used) + 1)
            grid.append(used[qv])
        grids.append(grid)
    palette = [(0, 0, 0)] + [tuple(rgb[3 * k:3 * k + 3]) for k in sorted(used, key=used.get)]
    assert len(palette) <= 256
    return grids, palette


def exact_overlay(images):
    """Overlay images (no anti-aliasing, so a handful of colours): per image its bbox crop as a grid of
    palette indices and its (x, y) on the canvas; one shared palette, a 1 x 1 transparent cell for none."""
    colours = {}
    for im in images:
        for r, g, b, a in im.get_flattened_data():
            if a:
                colours.setdefault((r, g, b), len(colours) + 1)
    assert len(colours) < 256
    out = []
    for im in images:
        box = im.getchannel('A').getbbox()
        if not box:
            out.append((1, 1, [0], (0, 0)))
            continue
        crop = im.crop(box)
        assert all(a in (0, 255) for *_, a in crop.get_flattened_data())
        out.append((crop.width, crop.height, [colours[(r, g, b)] if a else 0 for r, g, b, a in crop.get_flattened_data()],
                    (box[0], box[1])))
    return out, [(0, 0, 0)] + list(colours)


def mascot_centred(w, h, bias):
    """The working scene's offset that puts its frames' box — the mascot alone: props and bubbles are the overlay,
    which keeps its place from it — on the glass's centre (233, 233), for every engine (design 2026-10-06,
    focus-project.html "Working": "mascot centred at (233,233)")."""
    return (233 - w // 2) - (466 - w) // 2, (233 - h // 2) - (233 - h // 2 + bias)


def pack_rows(cols, rows, grid):
    """A frame's cells packed (terminal.h ht_cell_frame_t): per row, (skip, count) byte pairs each followed by `count`
    indices, until the row's cols are covered; and each row's start. Transparent runs cost two bytes, not their
    length (owner, 2026-10-06)."""
    out, at = [], []
    for r in range(rows):
        at.append(len(out))
        row, x = grid[r * cols:(r + 1) * cols], 0
        while x < cols:
            skip = 0
            while x < cols and not row[x]:
                skip += 1; x += 1
            run = []
            while x < cols and row[x]:
                run.append(row[x]); x += 1
            out += [skip, len(run)] + run
    assert len(out) < 65536
    return out, at


def cell_frames(prefix, items, palette_name, cell=1):
    """C definitions of de-duplicated cell frames, packed (pack_rows) when that is smaller; returns (code, index per
    item, count, bytes)."""
    code, seen, refs, order, nbytes = [], {}, [], [], 0
    for item in items:
        cols, rows, grid = item[:3]
        c = item[3] if len(item) > 3 else cell
        key = (cols, rows, c, tuple(grid))
        if key not in seen:
            seen[key] = n = len(refs)
            packed, at = pack_rows(cols, rows, grid)
            if len(packed) + 2 * rows < cols * rows:
                code.append(f'static const uint8_t {prefix}_c{n}[{len(packed)}] = {{' + ','.join(map(str, packed)) + '};\n')
                code.append(f'static const uint16_t {prefix}_r{n}[{rows}] = {{' + ','.join(map(str, at)) + '};\n')
                refs.append(f'{{{cols},{rows},{c},{palette_name},{prefix}_c{n},{prefix}_r{n}}}')
                nbytes += len(packed) + 2 * rows
            else:
                code.append(f'static const uint8_t {prefix}_c{n}[{cols * rows}] = {{' + ','.join(map(str, grid)) + '};\n')
                refs.append(f'{{{cols},{rows},{c},{palette_name},{prefix}_c{n},NULL}}')
                nbytes += cols * rows
        order.append(seen[key])
    code.append(f'static const ht_cell_frame_t {prefix}_frames[{len(refs)}] = {{' + ','.join(refs) + '};\n')
    return code, order, len(refs), nbytes


def generate_pack_scene(prefix, kind):
    """One Codex scene from the pack: robot frames + overlay (none while working), in the ht_pet_scene_t layout."""
    if kind == 'work':
        frames, seq, step_ms, levels, bias = pack_frames('running', 6), XWORK_STEPS, XWORK_MS, 1, 4
    elif kind == 'listen':
        frames, seq, step_ms, levels, bias = pack_frames('listening', 4), XLISTEN_FRAMES, XLISTEN_MS, LEVELS, -6
    else:
        frames, seq, step_ms, levels, bias = pack_frames('waving', 4), XSEND_STEPS, XSEND_MS, 1, 0
    steps = len(seq)
    ink = [f.getchannel('A').getbbox() for f in frames]
    box = (min(b[0] for b in ink), min(b[1] for b in ink), max(b[2] for b in ink), max(b[3] for b in ink))
    w, h = box[2] - box[0], box[3] - box[1]
    assert w < 256 and h < 256
    grids, palette = quantise_robot(frames, box)
    out = [f'static const uint16_t {prefix}_pal[{len(palette)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(palette)) + '};\n']
    code, order, n, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    robot_step = [i for _ in range(levels) for i in seq]
    loop = [order[i] for i in robot_step]
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {steps} * {"HT_PET_SCENE_LEVELS" if levels > 1 else 1}, "{prefix}: steps x levels");\n')
    # The overlay, one image per (level, step) like the loop.
    x0, y0 = (466 - CW) // 2 + RX + box[0], (466 - CH) // 2 + RY + box[1]
    if kind == 'work':
        dx, dy = mascot_centred(w, h, bias)
        out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{steps},{step_ms},NULL,{dx},{dy},NULL,NULL,NULL,NULL,NULL}};\n')
        return out, n, nbytes + len(palette) * 2
    if kind == 'listen':
        images = [listen_bubble()]               # one frame: the bars are drawn in code, the loop is all zeros
    else:
        images = [send_overlay(s, steps) for s in range(steps)]
    shapes, opal = exact_overlay(images)
    ov = prefix + '_ov'
    out.append(f'static const uint16_t {ov}_pal[{len(opal)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(opal)) + '};\n')
    code, oorder, on, obytes = cell_frames(ov, [(c, r, g) for c, r, g, _ in shapes], f'{ov}_pal')
    out += code
    if kind == 'listen':                             # one bubble for every (level, step)
        oorder = oorder * (levels * steps)
        shapes = shapes * (levels * steps)
    out.append(f'static const uint8_t {ov}_loop[{len(oorder)}] = {{' + ','.join(map(str, oorder)) + '};\n')
    # at: where each step's frame sits from the scene's origin (the robot's ink box), in px.
    at = [(x - RX - box[0], y - RY - box[1]) if (x or y) else (0, 0) for *_, (x, y) in shapes]
    out.append(f'static const int16_t {ov}_at[{len(at)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in at) + '};\n')
    out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
    # The sprite's home-face place is the mockup's: the robot at (RX, RY) in the canvas centred on the glass.
    dx, dy = x0 - (466 - w) // 2, y0 - (233 - h // 2 + bias)
    bars = ',NULL'
    if kind == 'listen':
        # The bars, from the scene's origin (the robot's ink box): x, centre y, 8 px of ink, radius, the swing, fills.
        fills = ','.join(str(rgb565(ImageColor.getrgb(c))) for c in (CX_BAR, CX_BAR_HI, CX_BAR))
        out.append(f'static const ht_pet_bars_t {prefix}_bars = {{{{{",".join(str(x - box[0]) for x in BAR_X)}}},{BAR_CY - box[1]},'
                   f'{BAR_W + 1},{BAR_RADIUS},{BAR_MIN},{BAR_SWING},{{{fills}}},{BAR_PERIOD_MS},{BAR_PHASE}f}};\n')
        bars = f',&{prefix}_bars'
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{steps},{step_ms},&{ov},{dx},{dy}{bars},NULL,NULL,NULL,NULL}};\n')
    return out, n + on, nbytes + obytes + (len(palette) + len(opal)) * 2


# ---- Muse Code's Jolly: PNG frames (assets/pets/muse, straight alpha, device scale) ----
MUSE = root / 'assets/pets/muse'
MUSE_SCENES = json.loads((MUSE / 'scenes.json').read_text())
MUSE_FLY = json.loads((MUSE / 'send.json').read_text())
MUSE_WAVES = json.loads((MUSE / 'listen.json').read_text())['waves']
MUSE_REST_MS = MUSE_SCENES['rest']['step_ms']
MUSE_SEND_HOLD = 5        # the sending scene's last step shows this many steps (900 ms asked, 5 x 166 = 830)


def muse_frames(folder, alpha_cut=True):
    """The PNGs of a folder, alpha thresholded at 128 (the dial's alpha is 1 bit; the edge colour is
    composited over black by the quantiser, so no halo)."""
    out = []
    for path in sorted((MUSE / folder).glob('*.png')):
        im = Image.open(path).convert('RGBA')
        if alpha_cut:
            im.putalpha(im.getchannel('A').point(lambda a: 255 if a >= 128 else 0))
        out.append(im)
    return out


def union_box(frames):
    boxes = [f.getchannel('A').getbbox() for f in frames]
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def quantise_pieces(pieces):
    """Like quantise_robot for images of different sizes (already cropped): per image a grid of palette
    indices (1..) and 0 where it is transparent or pure black; one <= 255 colour palette for all."""
    black = [Image.alpha_composite(Image.new('RGBA', p.size, (0, 0, 0, 255)), p).convert('RGB') for p in pieces]
    strip = Image.new('RGB', (sum(f.width for f in black), max(f.height for f in black)))
    x = 0
    for f in black:
        strip.paste(f, (x, 0))
        x += f.width
    pal = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    rgb = pal.getpalette()
    grids, used = [], {}
    for f, src in zip(black, pieces):
        q = f.quantize(palette=pal, dither=Image.Dither.NONE)
        grid = []
        for qv, a, px in zip(q.get_flattened_data(), src.getchannel('A').get_flattened_data(), f.get_flattened_data()):
            if not a or px == (0, 0, 0):
                grid.append(0)
                continue
            used.setdefault(qv, len(used) + 1)
            grid.append(used[qv])
        grids.append(grid)
    palette = [(0, 0, 0)] + [tuple(rgb[3 * k:3 * k + 3]) for k in sorted(used, key=used.get)]
    assert len(palette) <= 256
    return grids, palette


def muse_rest_images():
    """The small pet: the 24 waving frames over black, cropped to their union ink box (RGBA, alpha 0 / 255)."""
    frames = muse_frames('rest2x')
    box = union_box(frames)
    out = []
    for f in frames:
        rgb = Image.alpha_composite(Image.new('RGBA', f.size, (0, 0, 0, 255)), f).convert('RGB')
        im = rgb.convert('RGBA')
        im.putalpha(f.getchannel('A'))
        out.append(im.crop(box))
    return out


# The rest loop: two waves, and on the third the arm goes down and comes back up (owner, 2026-10-06; mockup/
# muse-wave.html "C2"; the 24-frame clip cost 408 KB). The clip's own order, so every step is a neighbour: wave 1
# (18-21), wave 2 (22, 23, 3-5: frames 0-2 left out, where the clip straightens the head and tilts it back), the
# third (6, 7) turning into the way down (11-15) and up again (16, 17), which runs on into 18. 18 steps of 217 ms.
MUSE_REST_SEQ = [18, 19, 20, 21, 22, 23, 3, 4, 5, 6, 7, 11, 12, 13, 14, 15, 16, 17]


def muse_pet_states():
    """One loop (MUSE_REST_SEQ) for idle / working / done / asking; only the frames it shows are stored."""
    ims = muse_rest_images()
    assert len(ims) == 24 and len(MUSE_REST_SEQ) <= STEPS
    loop = [({'i': i}, 0) for i in MUSE_REST_SEQ]
    return (lambda: loop,) * 4, ims


MUSE_STATES, MUSE_IMAGES = muse_pet_states()
MUSE_SIZE = MUSE_IMAGES[0].size


def muse_render(cells):
    return MUSE_IMAGES[cells['i']]


def clip_to_glass(im, gx, gy):
    """The plane's swoosh flies off the left edge: drop the pixels at r >= 229 on the 466 glass (the dial keeps
    all ink inside r 230; the bezel hides them anyway). `gx`, `gy`: where the image's top-left lands on the glass."""
    im = im.copy()
    a = im.getchannel('A')
    px = a.load()
    for y in range(im.height):
        for x in range(im.width):
            if (gx + x - 233) ** 2 + (gy + y - 233) ** 2 >= 229 * 229:
                px[x, y] = 0
    im.putalpha(a)
    return im


def generate_muse_scene(prefix, kind):
    """One Muse scene from its PNG frames: Jolly frames + (sending) the plane overlay, in the ht_pet_scene_t layout."""
    folder, bias = {'work': ('work', 4), 'listen': ('listen', -6), 'send': ('send/body', 0)}[kind]
    meta = MUSE_SCENES[{'work': 'work', 'listen': 'listen', 'send': 'send'}[kind]]
    frames = muse_frames(folder)
    seq = list(range(len(frames)))
    levels = LEVELS if kind == 'listen' else 1
    if kind == 'send':
        seq += [seq[-1]] * (MUSE_SEND_HOLD - 1)
    steps = len(seq)
    box = union_box(frames)
    w, h = box[2] - box[0], box[3] - box[1]
    assert w < 256 and h < 256
    cw, ch = meta['size']
    assert frames[0].size == (cw, ch)
    grids, palette = quantise_pieces([f.crop(box) for f in frames])
    out = [f'static const uint16_t {prefix}_pal[{len(palette)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(palette)) + '};\n']
    code, order, n, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    loop = [order[i] for _ in range(levels) for i in seq]
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {steps} * {"HT_PET_SCENE_LEVELS" if levels > 1 else 1}, "{prefix}: steps x levels");\n')
    ov_ref, extra, obytes = 'NULL', 0, 0
    if kind == 'send':
        fly = muse_frames('send/fly')
        assert len(MUSE_FLY) == len(frames)
        pieces, where = [], []
        for item in MUSE_FLY:
            if item.get('empty'):
                pieces.append(None)
                where.append((0, 0))
            else:
                pieces.append(clip_to_glass(fly[item['frame']], meta['centre'][0] - cw // 2 + item['x'],
                                            meta['centre'][1] - ch // 2 + item['y']))
                where.append((item['x'] - box[0], item['y'] - box[1]))
        real = [p for p in pieces if p is not None]
        ogrids, opal = quantise_pieces(real)
        it = iter(ogrids)
        shapes = []
        for p in pieces:
            shapes.append((1, 1, [0]) if p is None else (p.width, p.height, next(it)))
        ov = prefix + '_ov'
        out.append(f'static const uint16_t {ov}_pal[{len(opal)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(opal)) + '};\n')
        code, oorder, on, obytes = cell_frames(ov, shapes, f'{ov}_pal')
        out += code
        oloop = [oorder[i] for i in seq]
        at = [where[i] for i in seq]
        out.append(f'static const uint8_t {ov}_loop[{len(oloop)}] = {{' + ','.join(map(str, oloop)) + '};\n')
        out.append(f'static const int16_t {ov}_at[{len(at)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in at) + '};\n')
        out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
        ov_ref, extra, obytes = '&' + ov, on, obytes + len(opal) * 2
    # The scene's canvas centre lands on the glass at meta['centre']; focus.c centres the ink box (plus `bias`).
    x0 = meta['centre'][0] - cw // 2 + box[0]
    y0 = meta['centre'][1] - ch // 2 + box[1]
    dx, dy = x0 - (466 - w) // 2, y0 - (233 - h // 2 + bias)
    if kind == 'work':
        dx, dy = mascot_centred(w, h, bias)
    waves = 'NULL'
    if kind == 'listen':
        # L2: the sound waves are drawn by the dial (ht_pet_waves_t), from assets/pets/muse/listen.json; the body
        # frames carry none, so poses that mirror each other (step t and 6 - t) are one stored picture.
        wv = MUSE_WAVES
        assert 1 <= wv['count'] <= 3        # focus.c: runs 1..6 are the arcs
        out.append(f'static const ht_pet_waves_t {prefix}_waves = {{{round((wv["centre"][0] - box[0]) * 16)},'
                   f'{round((wv["centre"][1] - box[1]) * 16)},{round(wv["r_far"] * 16)},{round(wv["r_near"] * 16)},'
                   f'{round(wv["width"] * 16)},{wv["half_angle_deg"]},{wv["count"]},{{{",".join(map(str, wv["colour"]))}}},'
                   f'{wv["period_ms"]},0}};\n')
        waves = f'&{prefix}_waves'
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{steps},{meta["step_ms"]},{ov_ref},{dx},{dy},NULL,{waves},NULL,NULL,NULL}};\n')
    return out, n + extra, nbytes + obytes + len(palette) * 2


# ---- Claude Code's Clawd: PNG frames (assets/pets/claude, exported by mockup/clawd_v3.py) ----
# Drawn at the glass's 1 px with every edge anti-aliased into opaque colour over black (the dial keeps on/off
# alpha), at 55-65 ms a step. Each scene is a body (a few stored poses; a hop or a nod is the step's dy, not a new
# pose) and per step a props sprite (the pan and food, the letter and the post box's flag) placed
# per px; a scene's `cell2` sprites, if any, are stored at 2 px cells. Listening's sound arcs
# are drawn by focus.c (ht_pet_waves_t, one set at each cup). The small pet is the rest loop, 24 steps.
CLAUDE = root / 'assets/pets/claude'
CLAUDE_SCENES = json.loads((CLAUDE / 'scenes.json').read_text())


def claude_frames(folder):
    return [Image.open(p).convert('RGBA') for p in sorted((CLAUDE / folder).glob('*.png'))]


def half(im):
    """A soft sprite at 2 px cells: box-filtered to half size, colour kept over black, alpha cut at 1/4."""
    w, h = (im.width + 1) // 2, (im.height + 1) // 2
    big = Image.new('RGBA', (w * 2, h * 2), (0, 0, 0, 0))
    big.paste(im, (0, 0))
    small = big.resize((w, h), Image.BOX)
    rgb = Image.alpha_composite(Image.new('RGBA', small.size, (0, 0, 0, 255)), small)
    rgb.putalpha(small.getchannel('A').point(lambda a: 255 if a >= 64 else 0))
    return rgb


def generate_claude_scene(prefix, name, levels, bias):
    meta = CLAUDE_SCENES[name]
    bodies, props = claude_frames(f'{name}/body'), claude_frames(f'{name}/props')
    w, h = bodies[0].size
    assert w < 256 and h < 256
    steps = meta['steps']
    grids, palette = quantise_pieces(bodies)
    out = [f'static const uint16_t {prefix}_pal[{len(palette)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(palette)) + '};\n']
    code, order, n, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    loop = [order[st[0]] for _ in range(levels) for st in steps]
    dys = [st[4] for _ in range(levels) for st in steps]
    assert all(-128 <= d < 128 for d in dys)
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {len(steps)} * {"HT_PET_SCENE_LEVELS" if levels > 1 else 1}, "{prefix}: steps x levels");\n')
    out.append(f'static const int8_t {prefix}_dy[{len(dys)}] = {{' + ','.join(map(str, dys)) + '};\n')
    x0, y0 = meta['body_at']
    ov_ref, on, obytes = 'NULL', 0, 0
    if props:
        soft = set(meta.get('cell2', []))
        pieces = [half(p) if i in soft else p for i, p in enumerate(props)]
        ogrids, opal = quantise_pieces(pieces)
        shapes = [(p.width, p.height, g, 2 if i in soft else 1) for i, (p, g) in enumerate(zip(pieces, ogrids))]
        shapes.append((1, 1, [0]))                     # "nothing now"
        ov = prefix + '_ov'
        out.append(f'static const uint16_t {ov}_pal[{len(opal)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(opal)) + '};\n')
        ocode, oorder, on, obytes = cell_frames(ov, shapes, f'{ov}_pal')
        out += ocode
        none = oorder[-1]
        oloop = [oorder[st[1]] if st[1] >= 0 else none for _ in range(levels) for st in steps]
        at = [(st[2] - x0, st[3] - y0) if st[1] >= 0 else (0, 0) for _ in range(levels) for st in steps]
        out.append(f'static const uint8_t {ov}_loop[{len(oloop)}] = {{' + ','.join(map(str, oloop)) + '};\n')
        out.append(f'static const int16_t {ov}_at[{len(at)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in at) + '};\n')
        out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
        ov_ref, obytes = '&' + ov, obytes + len(opal) * 2
    dx, dy = x0 - (466 - w) // 2, y0 - (233 - h // 2 + bias)
    if name == 'work':
        dx, dy = mascot_centred(w, h, bias)
    waves = 'NULL'
    if 'waves' in meta:
        wv = meta['waves']
        assert 1 <= wv['count'] <= 3        # focus.c: runs 1..6 are the arcs
        out.append(f'static const ht_pet_waves_t {prefix}_waves = {{{round((wv["centre"][0] - x0) * 16)},'
                   f'{round((wv["centre"][1] - y0) * 16)},{round(wv["r_far"] * 16)},{round(wv["r_near"] * 16)},'
                   f'{round(wv["width"] * 16)},{wv["half_angle_deg"]},{wv["count"]},{{{",".join(map(str, wv["colour"]))}}},'
                   f'{wv["period_ms"]},{round(wv["gap"] * 16)}}};\n')
        waves = f'&{prefix}_waves'
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{len(steps)},'
               f'{meta["step_ms"]},{ov_ref},{dx},{dy},NULL,{waves},{prefix}_dy,NULL,NULL}};\n')
    return out, n + on, nbytes + obytes + len(palette) * 2 + len(dys)


def claude_pet_states():
    """The small pet: the rest loop (24 steps) for idle / working / done / asking; identical frames stored once."""
    ims = claude_frames('rest2x')
    assert len(ims) == STEPS
    seen, index = {}, []
    for i, im in enumerate(ims):
        index.append(seen.setdefault(im.tobytes(), i))
    loop = [({'i': index[i]}, 0) for i in range(STEPS)]
    return (lambda: loop,) * 4, ims


CLAUDE_STATES, CLAUDE_IMAGES = claude_pet_states()


def claude_render(cells):
    return CLAUDE_IMAGES[cells['i']]


def rgb565(rgb):
    """Native RGB565, what ht_rgb() returns and ht_box() takes (the sprites' palettes are panel order)."""
    r, g, b = rgb
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def rgb565_panel(rgb):
    r, g, b = rgb
    v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    return ((v << 8) | (v >> 8)) & 0xFFFF


def emit(name, img):
    w, h = img.size
    px, alpha = [], []
    for r, g, b, a in img.get_flattened_data():
        v = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
        px.append(((v << 8) | (v >> 8)) & 0xFFFF)
        alpha.append(255 if a else 0)
    return (f'static const uint16_t {name}_px[] = {{' + ','.join(map(str, px)) + '};\n'
            f'static const uint8_t {name}_a[] = {{' + ','.join(map(str, alpha)) + '};\n',
            f'{{{w},{h},{name}_px,{name}_a}}')


# engine, prefix, frame size, the four states, renderer, step_ms
CODEX_STATES, CODEX_IMAGES, CODEX_STEP_MS = codex_pet_states()
PETS = (
    ('claude', 'claude', half_size(CLAUDE_IMAGES[0].size), CLAUDE_STATES, claude_render, (CLAUDE_SCENES['rest']['step_ms'],) * 4),
    ('codex', 'codex', half_size(CODEX_IMAGES[0].size), CODEX_STATES, codex_render, CODEX_STEP_MS),
    ('muse', 'muse', half_size(MUSE_SIZE), MUSE_STATES, muse_render, (MUSE_REST_MS,) * 4),
)
# Pets whose small self is palette-indexed cell frames (ht_pet_t.cells) rather than RGB565 + alpha8 (frames).
# Every small pet is cell frames drawn at TWICE its size (1 px cells of a 2x picture), which focus.c shows at 1x, 1.5x, 1.75x or 2x with ht_cell_sprite_zoom: one good drawing, every
# size a clean reduction of it (owner, 2026-10-05). The value is the frames' cell; ht_pet_t.w, h are the 1x size.
CELL_PETS = {'claude': 1, 'codex': 1, 'muse': 1}


def generate_pet(prefix, states, draw, size, cells_out=False, cell=1):
    frames, index, loops = [], {}, []
    for state in states:
        steps = []
        for cells, dy in state():
            key = tuple(sorted(cells.items()))
            if key not in index:
                index[key] = len(frames)
                frames.append(cells)
            steps.append((index[key], dy))
        loops.append(steps)
    out, refs = [], []
    if cells_out:
        # One palette for the pet's frames; cell_frames de-duplicates again, so the loops follow its order.
        images = [draw(cells) for cells in frames]
        grids, palette = quantise_pieces(images)
        out.append(f'static const uint16_t {prefix}_pal[{len(palette)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(palette)) + '};\n')
        code, order, n, nbytes = cell_frames(prefix, [(im.width, im.height, g) for im, g in zip(images, grids)], f'{prefix}_pal', cell)
        out += code
        rep = [None] * n
        for f, j in enumerate(order):
            if rep[j] is None:
                rep[j] = frames[f]
        return out, n, [[(order[f], dy) for f, dy in steps] for steps in loops], nbytes + len(palette) * 2, rep
    for n, cells in enumerate(frames):
        code, ref = emit(f'{prefix}{n}', draw(cells))
        out.append(code)
        refs.append(ref)
    out.append(f'static const ht_icon_t {prefix}_frames[{len(refs)}] = {{' + ','.join(refs) + '};\n')
    return out, len(refs), loops, len(refs) * size[0] * size[1] * 3, frames


# ---- THE ALERT: a notice arrives while the agent works (owner, 2026-10-05; one bell bubble for every pet,
# 2026-10-07, mockup/alert_count.py "keep the bell, the number beside it") ----
# The working scene plays on and a bubble with a blue bell and room for the count pops up beside the pet: 46 steps
# of 110 ms, nothing for four, popped in over three (a little overshoot), then bobbing while the bell rings in
# bursts; the last step is the bubble at rest, which focus.c holds until the notices are read. The count is not
# stored: focus.c writes it in the bubble, centred on the step's count_at (none while it pops in). The scene has
# no frames of its own (focus.c draws the working scene under it); `at` and count_at are from the working scene's
# origin. Claude's sits left of its hat, clear of the pan; Codex's where its sandbox bubble was.
ALERT_STEPS, ALERT_MS = 46, 110
ABLUE = (0, 111, 255)
ALERT_RING = [0, 16, -16, 12, -12, 7, -7, 0, 0, 0, 0, 0]      # the bell's swing, degrees per step, from step 6
ALERT_POP = 6                                                # steps before the bubble is whole and the count shows
ALERT_W, ALERT_H = 68, 44                                    # the bubble: the bell, then a slot for "1".."9+"
# engine: the bubble's left edge (its tail lower left) or right edge (tail lower right), its centre y, fill, edge
ALERT_BUBBLES = {
    'claude': ((186, 'right'), 168, (246, 242, 238), (246, 242, 238)),
    'codex': ((290, 'left'), 160, CX_FILL, CX_LINE),
    'muse': ((271, 'left'), 150, (246, 244, 240), (205, 200, 192)),
}


def abell(d, cx, cy, s, col):
    d.pieslice([cx - 5 * s, cy - 6 * s, cx + 5 * s, cy + 4 * s], 180, 360, fill=col)
    d.rectangle([cx - 5 * s, cy - 1 * s, cx + 5 * s, cy + 3 * s], fill=col)
    d.rectangle([cx - 6.5 * s, cy + 3 * s, cx + 6.5 * s, cy + 4.5 * s], fill=col)
    d.ellipse([cx - 1.6 * s, cy + 4.5 * s, cx + 1.6 * s, cy + 7 * s], fill=col)


def bell_bubble(im, edge_x, cy, k, fill, edge, angle):
    """The bubble, `k` 0..1 popping it in with a little overshoot from its tail's side, the blue bell at its left
    swung `angle` degrees about its top. Returns the count slot's centre. No anti-aliasing (exact_overlay keeps a
    handful of colours)."""
    s = (1.0 + 0.18 * math.sin(k * math.pi) if k < 1 else 1.0) * min(1.0, k * 1.6)
    w, h = ALERT_W * s, ALERT_H * s
    x0 = edge_x[0] if edge_x[1] == 'left' else edge_x[0] - w
    d = ImageDraw.Draw(im)
    if edge_x[1] == 'left':
        tx, far = x0 + 11 * s, -1
    else:
        tx, far = x0 + w - 11 * s, 1
    d.polygon([(tx - 6 * s, cy + h / 2 - 2), (tx + 6 * s, cy + h / 2 - 2), (tx + far * 10 * s, cy + h / 2 + 11 * s)], fill=edge)
    d.rounded_rectangle([x0, cy - h / 2, x0 + w, cy + h / 2], radius=13 * s, fill=fill, outline=edge, width=2)
    d.polygon([(tx - 4 * s, cy + h / 2 - 3), (tx + 4 * s, cy + h / 2 - 3), (tx + far * 7 * s, cy + h / 2 + 7 * s)], fill=fill)
    bell = Image.new('RGBA', (80, 80), (0, 0, 0, 0))
    abell(ImageDraw.Draw(bell), 40, 40, 1.75 * s, ABLUE)
    bell = bell.rotate(angle, resample=Image.NEAREST, center=(40, 40 - 9 * s))
    im.alpha_composite(bell, (round(x0 + 21 * s - 40), round(cy - 1.5 * s - 40)))
    return round(x0 + 48 * s), round(cy)


def alert_bubbles(edge_x, cy, fill, edge):
    """The overlay per step, on a glass-sized canvas, and the count slot's centre on the glass (None while popping)."""
    out, slots = [], []
    for t in range(ALERT_STEPS):
        im = Image.new('RGBA', (466, 466), (0, 0, 0, 0))
        k = min(1.0, (t - 3) / 3)
        slot = None
        if k > 0:
            rest = t == ALERT_STEPS - 1                      # the bubble held after the ring: still, not lifted
            angle = 0 if rest or t < ALERT_POP else ALERT_RING[(t - ALERT_POP) % len(ALERT_RING)]
            lift = 0 if rest else (2 if ((t + 1) // 2) % 2 else 0)
            slot = bell_bubble(im, edge_x, cy - lift, k, fill, edge, angle)
        out.append(im)
        slots.append(slot if t >= ALERT_POP else None)
    return out, slots


def generate_alert(prefix, engine, work_code, work_prefix):
    """The bell bubble over the working scene; `work_code` is the working scene's generated C, read for its origin."""
    edge_x, cy, fill, edge = ALERT_BUBBLES[engine]
    m = re.search(rf'ht_pet_scene_t {work_prefix} = {{(-?\d+),(-?\d+),[^,]*,[^,]*,\d+,\d+,[^,]*,(-?\d+),(-?\d+),', work_code)
    w, h, dx, dy = map(int, m.groups())
    ox, oy = (466 - w) // 2 + dx, 233 - h // 2 + 4 + dy             # focus.c scene_origin, bias 4
    images, slots = alert_bubbles(edge_x, cy, ImageColor.getrgb(fill) if isinstance(fill, str) else fill,
                                  ImageColor.getrgb(edge) if isinstance(edge, str) else edge)
    shapes, opal = exact_overlay(images)
    ov = prefix + '_ov'
    out = [f'static const uint16_t {ov}_pal[{len(opal)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(opal)) + '};\n']
    code, order, n, nbytes = cell_frames(ov, [(c_, r_, g_) for c_, r_, g_, _ in shapes], f'{ov}_pal')
    out += code
    out.append(f'static const uint8_t {ov}_loop[{len(order)}] = {{' + ','.join(map(str, order)) + '};\n')
    oat = [(x - ox, y - oy) if (x or y) else (0, 0) for *_, (x, y) in shapes]
    out.append(f'static const int16_t {ov}_at[{len(oat)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in oat) + '};\n')
    out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
    # count_at: the slot's centre from the working scene's origin, {0,0} = no count on that step
    cat = [(x - ox, y - oy) if c else (0, 0) for c in slots for x, y in [c or (0, 0)]]
    assert all(c != (0, 0) for c, sl in zip(cat, slots) if sl)
    out.append(f'static const int16_t {prefix}_count_at[{len(cat)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in cat) + '};\n')
    out.append(f'static const ht_pet_scene_t {prefix} = {{0,0,NULL,NULL,{ALERT_STEPS},{ALERT_MS},&{ov},0,0,NULL,NULL,NULL,'
               f'{prefix}_count_at,NULL}};\n')
    return out, n, nbytes + len(opal) * 2 + len(cat) * 4


# ---- THE RELAXING SCENES: the resting face laid out like the working one (owner, 2026-10-09, mockup/relaxing.html) ----
# Claude juggles three balls, Codex throws and catches its paper plane, Muse keeps a beach ball up off its head
# (mockup/muse-play.html D, owner 2026-10-09: it moves as a whole, never bending a joint); 24 steps each. The
# bodies are stored like the other scenes (palette cells, cell 1) and placed where the mockup's glass has them (bias 4,
# as the working scene); the balls are NOT stored: per step a few shapes (ht_pet_shapes_t) that focus.c
# draws as ring arcs. Claude's and Muse's come from assets/pets/<engine>/relax{/,.json} (exported by
# mockup/relax_export.py from clawd_juggle.py B and muse_play.py D); Codex's from its pack, drawn here (relaxing.py).
RELAX_N = 24
RELAX_BIAS = 4


def relax_shapes(prefix, shapes, x0, y0):
    """The JSON shapes (glass px) as ht_pet_shape_t from the scene's origin (x0, y0), in sixteenths of a px."""
    count = len(shapes[0])
    assert all(len(st) == count for st in shapes) and 0 < count <= 28    # focus.c: 11 runs + these <= HT_RUNS (40)
    rows = []
    for st in shapes:
        for sh in st:
            kind, cx, cy = sh[0], round((sh[1] - x0) * 16), round((sh[2] - y0) * 16)
            if kind == 'none':
                rows.append((cx, cy, 0, 0, 0, 0, 0))
            elif kind == 'disc':          # the band from the centre (a 1/2 px inside it) out to r: fully covered at the centre
                R = round(sh[3] * 16)
                rows.append((cx, cy, max(0, (R - 8) // 2), R + 8, 0, 180, rgb565(sh[4])))
            else:
                r, w, mid, half, col = sh[3:8]
                rows.append((cx, cy, round(r * 16), max(1, round(w * 16)), int(mid), int(half), rgb565(col)))
    out = [f'static const ht_pet_shape_t {prefix}_shape_at[{len(rows)}] = {{' +
           ','.join('{' + ','.join(map(str, r)) + '}' for r in rows) + '};\n',
           f'static const ht_pet_shapes_t {prefix}_shapes = {{{count},{prefix}_shape_at}};\n']
    return out, len(rows) * 14


def generate_json_relax(prefix, folder):
    """Claude's or Muse's relaxing scene from assets/pets/<engine>/relax (poses) and relax.json (steps, shapes)."""
    meta = json.loads((folder.parent / 'relax.json').read_text())
    bodies = [Image.open(p).convert('RGBA') for p in sorted(folder.glob('*.png'))]
    bodies = [im.copy() for im in bodies]
    for im in bodies:
        im.putalpha(im.getchannel('A').point(lambda a: 255 if a >= 128 else 0))
    w, h = bodies[0].size
    assert w < 256 and h < 256 and len(meta['steps']) == RELAX_N
    grids, palette = quantise_pieces(bodies)
    out = [f'static const uint16_t {prefix}_pal[{len(palette)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(palette)) + '};\n']
    code, order, n, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    loop = [order[st[0]] for st in meta['steps']]
    dys = [st[1] for st in meta['steps']]
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {RELAX_N}, "{prefix}: steps");\n')
    dy_ref = 'NULL'
    if any(dys):
        out.append(f'static const int8_t {prefix}_dy[{len(dys)}] = {{' + ','.join(map(str, dys)) + '};\n')
        dy_ref = f'{prefix}_dy'
        nbytes += len(dys)
    x0, y0 = meta['body_at']
    scode, sbytes = relax_shapes(prefix, meta['shapes'], x0, y0)
    out += scode
    dx, dy = x0 - (466 - w) // 2, y0 - (233 - h // 2 + RELAX_BIAS)
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{RELAX_N},{meta["step_ms"]},'
               f'NULL,{dx},{dy},NULL,NULL,{dy_ref},NULL,&{prefix}_shapes}};\n')
    return out, n, nbytes + sbytes + len(palette) * 2


# Codex plays with its paper plane (relaxing.py, from clawd-on-desk's cloudling-juggling.gif): holds it up, throws it,
# the plane laps round it (behind its head, then in front) and comes back to be caught. The robot is the pack's waving
# 1-2 (hand up, the throw, the catch) and idle 0-1 (watching; a happy squint while the plane is behind it); the plane
# and its dotted trail are the overlay, one sprite per step, the part behind the robot cut out of it.
XRELAX_MS = 120
XROBOT_AT = (233 - 96, 234 - 104)                      # the 192 x 208 frame's top-left on the glass
XHAND = (XROBOT_AT[0] + 34, XROBOT_AT[1] + 120)        # the raised hand in waving frames 1-2
XLOOP = dict(cx=240, cy=214, rx=124, ry=44)
XTHROW, XCATCH = 3, 19                                 # the step it lets go, the step it has it back


def relax_plane(d, x, y, ang, s):
    """send_overlay's plane (nose at +x), turned to `ang` about its centre and scaled by `s`."""
    c, sn = math.cos(ang), math.sin(ang)

    def T(pts):
        return [(x + ((px - 15) * c - (py - 9) * sn) * s, y + ((px - 15) * sn + (py - 9) * c) * s) for px, py in pts]
    d.polygon(T([(0, 10), (30, 0), (12, 18)]), fill=CX_BAR_HI, outline=CX_LINE)
    d.polygon(T([(12, 18), (30, 0), (15, 11)]), fill=CX_BAR)


def relax_loop_at(k):
    """The plane at k (0 at the hand .. 1 back at it): one lap of an ellipse round the robot; depth < 0 behind it."""
    a = math.pi + 2 * math.pi * k
    ex, ey = XLOOP['cx'] + XLOOP['rx'] * math.cos(a), XLOOP['cy'] + XLOOP['ry'] * math.sin(a)
    w = math.sin(math.pi * k) ** 0.5
    return XHAND[0] + (ex - XHAND[0]) * w, XHAND[1] + (ey - XHAND[1]) * w, math.sin(a)


def codex_relax_step(n, wave, idle):
    """The robot frame and the plane's overlay image (both glass-sized) at step n."""
    if n < XTHROW:
        robot = wave[1]
    elif n == XTHROW:
        robot = wave[2]
    elif n < XCATCH - 1:
        robot = idle[1 if 8 <= n <= 12 else 0]
    elif n == XCATCH - 1:
        robot = wave[2]
    else:
        robot = wave[1]
    body = Image.new('RGBA', (466, 466), (0, 0, 0, 0))
    body.alpha_composite(robot, XROBOT_AT)
    props = Image.new('RGBA', (466, 466), (0, 0, 0, 0))
    d = ImageDraw.Draw(props)
    if XTHROW < n < XCATCH:
        k = (n - XTHROW) / (XCATCH - XTHROW)
        x, y, depth = relax_loop_at(k)
        (bx, by, _), (fx, fy, _) = relax_loop_at(max(0, k - 0.01)), relax_loop_at(min(1, k + 0.01))
        for j in range(2, 9):                          # the dotted trail, thinning out
            kk = k - j * 0.02
            if kk <= 0:
                break
            tx, ty, td = relax_loop_at(kk)
            r = (2.6 if td > 0 else 2.0) * (1 - j / 11)
            d.ellipse((tx - r, ty - r, tx + r, ty + r), fill=CX_BAR)
        relax_plane(d, x, y, math.atan2(fy - by, fx - bx), 1.35 + 0.3 * depth)
        if depth < 0:                                  # behind the robot: hidden where it is
            behind = body.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
            props.putalpha(ImageChops.subtract(props.getchannel('A'), behind))
    else:                                              # in the hand, nose up and out
        relax_plane(d, XHAND[0] - 2, XHAND[1] - 14, -1.1, 1.25)
    props.putalpha(props.getchannel('A').point(lambda v: 255 if v >= 128 else 0))
    return robot, props


def generate_codex_relax(prefix):
    wave, idle = pack_frames('waving', 4), pack_frames('idle', 6)
    steps = [codex_relax_step(n, wave, idle) for n in range(RELAX_N)]
    robots = [wave[1], wave[2], idle[0], idle[1]]
    ink = [f.getchannel('A').getbbox() for f in robots]
    box = (min(b[0] for b in ink), min(b[1] for b in ink), max(b[2] for b in ink), max(b[3] for b in ink))
    w, h = box[2] - box[0], box[3] - box[1]
    assert w < 256 and h < 256
    grids, palette = quantise_robot(robots, box)
    out = [f'static const uint16_t {prefix}_pal[{len(palette)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(palette)) + '};\n']
    code, order, n, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    which = [next(i for i, r in enumerate(robots) if r is robot) for robot, _ in steps]
    loop = [order[i] for i in which]
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {RELAX_N}, "{prefix}: steps");\n')
    x0, y0 = XROBOT_AT[0] + box[0], XROBOT_AT[1] + box[1]       # the scene's origin on the glass
    shapes, opal = exact_overlay([p for _, p in steps])
    ov = prefix + '_ov'
    out.append(f'static const uint16_t {ov}_pal[{len(opal)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(opal)) + '};\n')
    ocode, oorder, on, obytes = cell_frames(ov, [(c, r, g) for c, r, g, _ in shapes], f'{ov}_pal')
    out += ocode
    out.append(f'static const uint8_t {ov}_loop[{len(oorder)}] = {{' + ','.join(map(str, oorder)) + '};\n')
    at = [(x - x0, y - y0) if (x or y) else (0, 0) for *_, (x, y) in shapes]
    out.append(f'static const int16_t {ov}_at[{len(at)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in at) + '};\n')
    out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
    dx, dy = x0 - (466 - w) // 2, y0 - (233 - h // 2 + RELAX_BIAS)
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{RELAX_N},{XRELAX_MS},'
               f'&{ov},{dx},{dy},NULL,NULL,NULL,NULL,NULL}};\n')
    return out, n + on, nbytes + obytes + (len(palette) + len(opal)) * 2


RELAX = {'claude': ('claude_relax', lambda p: generate_json_relax(p, CLAUDE / 'relax')),
         'codex': ('codex_relax', generate_codex_relax),
         'muse': ('muse_relax', lambda p: generate_json_relax(p, MUSE / 'relax'))}


# engine -> (working scene, listening scene, sending scene): prefix, loop, size in cells, step_ms, steps; levels
# (Codex's: prefix and kind, generate_pack_scene)
SCENES = {
    'claude': (('claude_work', 'cwork'), ('claude_listen', 'clisten'), ('claude_send', 'csend')),
    'codex': (('codex_work', 'work'), ('codex_listen', 'listen'), ('codex_send', 'send')),
    'muse': (('muse_work', 'mwork'), ('muse_listen', 'mlisten'), ('muse_send', 'msend')),
}


def generate():
    out = ['// Generated by scripts/gen_pets.py. Do not edit.\n'
           '// The pets: per engine the de-duplicated frames and the idle/working/done/asking loops.\n'
           '#include "pets.h"\n']
    table, counts, scene_stats = [], [], []
    for engine, prefix, (w, h), states, draw, step_ms in PETS:
        cells_out = engine in CELL_PETS
        code, n_frames, loops, nbytes, rep = generate_pet(prefix, states, draw, (w, h), cells_out, CELL_PETS.get(engine, 1))
        out += code
        counts.append((n_frames, nbytes))
        n_steps = len(loops[0])
        assert all(len(steps) == n_steps for steps in loops) and n_steps <= STEPS
        # The loops' arrays hold HT_PET_STEPS; a shorter loop (ht_pet_t.steps) leaves the tail unused.
        rows = ['{' + ','.join(f'{{{f},{dy}}}' for f, dy in steps + [steps[-1]] * (STEPS - n_steps)) + '}' for steps in loops]
        out.append(f'static const ht_pet_step_t {prefix}_loops[HT_PET_STATES][HT_PET_STEPS] = {{' + ','.join(rows) + '};\n')
        out.append(f'static const uint16_t {prefix}_step_ms[HT_PET_STATES] = {{' + ','.join(map(str, step_ms)) + '};\n')
        refs_to = []
        for spec in SCENES.get(engine, (None, None, None)):
            if not spec:
                refs_to.append('NULL')
                continue
            if spec[1] in ('cwork', 'clisten', 'csend'):
                sprefix = spec[0]
                name = spec[1][1:]
                code, n, nbytes = generate_claude_scene(sprefix, name, LEVELS if name == 'listen' else 1,
                                                        {'work': 4, 'listen': -6, 'send': 0}[name])
            elif spec[1] in ('mwork', 'mlisten', 'msend'):
                sprefix = spec[0]
                code, n, nbytes = generate_muse_scene(sprefix, spec[1][1:])
            elif spec[1] in ('work', 'listen', 'send'):
                sprefix = spec[0]
                code, n, nbytes = generate_pack_scene(sprefix, spec[1])
            out += code
            scene_stats.append((sprefix, n, nbytes))
            refs_to.append('&' + sprefix)
        code, n, nbytes = generate_alert(f'{engine}_alert', engine, ''.join(out), SCENES[engine][0][0])
        out += code
        scene_stats.append((f'{engine}_alert', n, nbytes))
        relax = 'NULL'
        if engine in RELAX:
            rprefix, gen = RELAX[engine]
            code, n, nbytes = gen(rprefix)
            out += code
            scene_stats.append((rprefix, n, nbytes))
            relax = '&' + rprefix
        table.append(f'{{"{engine}",{w},{h},{"NULL" if cells_out else prefix + "_frames"},{prefix}_loops,{prefix}_step_ms,{",".join(refs_to)},{prefix + "_frames" if cells_out else "NULL"},&{engine}_alert,{0 if n_steps == STEPS else n_steps},{relax}}}')
    out.append('const ht_pet_t ht_pets[] = {' + ','.join(table) + '};\n')
    out.append(f'const unsigned ht_pet_count = {len(PETS)};\n')
    return ''.join(out), counts, scene_stats


def main():
    text, counts, scene_stats = generate()
    target = root / 'main/ui/habitat/pets.c'
    if '--check' in sys.argv[1:]:
        if not target.exists() or target.read_text() != text:
            print(f'{target} is stale: run scripts/gen_pets.py', file=sys.stderr)
            return 1
        return 0
    target.write_text(text)
    for (engine, *_), (n, nbytes) in zip(PETS, counts):
        print(f'{engine}: {n} frames, {nbytes} bytes')
    for name, n, nbytes in scene_stats:
        print(f'{name}: {n} frames, {nbytes} bytes')
    print(f'wrote {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
