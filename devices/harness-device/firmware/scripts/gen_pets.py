#!/usr/bin/env python3
"""The pets on the Focus agent screen: pixel art that stands in for an engine's static mark.

    python3 devices/harness-device/firmware/scripts/gen_pets.py          # write
    python3 devices/harness-device/firmware/scripts/gen_pets.py --check  # fail if stale

Claude Code: a 12 x 8 cell sprite at 5 px per cell plus one spare row on top, 60 x 45 px per frame.
Codex: a 14 x 14 cell cloud-headed robot at 4 px per cell, 56 x 56 px per frame.
Claude has three large scenes (Clawd cooking / headphones / rocket, mockup/clawd_scenes.py) at 8 px per cell,
stored as palette-indexed cell grids: 12 steps of 110 ms, 8 steps of 140 ms for each mic level 0..4, and 12
steps of 120 ms. Codex's three come from the owner's robot pack (assets/pets/codex; mockup/codex_options.py W2 / L1 / S2):
the pack's 192 x 208 robot frames at one byte per pixel (cell 1) and an overlay sprite (the sandbox bubble, the
equalizer bubble, the paper plane) drawn after them: 28 steps of 120 ms, 15 steps of 80 ms for each mic level
0..4, and 15 steps of 140 ms.
Muse Code: Jolly, Meta Muse's mascot, cut from Meta's own render and from Meta's waving clip
(assets/pets/muse, exported by mockup/muse_jolly.py; the look is mockup/muse-jolly.html). The small pet is
the waving clip, 24 frames cropped to their ink box, one loop for all four states. Its three scenes are
pack scenes like Codex's, from straight-alpha PNG frames at device scale (cell 1): working (headphones, typing
at the laptop) 8 steps of 140 ms, listening 12 steps of 140 ms for every mic level 0..4, and sending (the clip's
throw of a paper plane, the plane and its swoosh an overlay sprite) 13 steps of 166 ms with the last one held.
Each state (idle, working, done, asking) is a loop of 24 steps, each a frame and a vertical offset in
px, on the Pro daemons' clock. Frames are de-duplicated per pet, so the file holds each pose once and
the loops index it. Writes main/ui/habitat/pets.c: each pet's frames, loops and step_ms, and the
registry ht_pets[] / ht_pet_count (declared in pets.h). Frames use the same encoding as
gen_focus_marks.py: RGB565 in panel order plus alpha8 (0 or 255 only).
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
STEPS = 24

# ---- Claude Code ----
CELL = 5
W, H = 12 * CELL, 9 * CELL
BODY = (204, 120, 92)
EYE = (0, 0, 0)
LEGS = (2, 4, 7, 9)                  # leg columns
STEP_MS = (150, 90, 55, 140)         # idle, working, done, asking


def sprite(eyes='open', arms=0, legs=(2, 2, 2, 2), look=0):
    """One pose as {(col, row): colour}. arms: 0 level, -1 raised one row. legs: rows per leg."""
    cells = {}
    for r in range(6):
        for c in range(2, 10):
            cells[(c, r)] = BODY
    for r in (2 + arms, 3 + arms):
        for c in (0, 1, 10, 11):
            cells[(c, r)] = BODY
    for c, n in zip(LEGS, legs):
        for r in range(6, 6 + n):
            cells[(c, r)] = BODY
    if eyes == 'open':
        cells[(3 + look, 1)] = EYE
        cells[(8 + look, 1)] = EYE
    elif eyes == 'happy':            # ^ ^ : the eye cell lifted a row
        for c in (3, 8):
            cells[(c, 0)] = EYE
    return cells                     # 'closed' leaves the eyes as body


def idle():
    bob = (0,) * 6 + (1,) * 6 + (0,) * 6 + (1,) * 6
    return [(sprite('closed' if i in (20, 21) else 'open'), bob[i]) for i in range(STEPS)]


def working():
    out = []
    for i in range(STEPS):
        phase = (i // 3) % 4
        legs = [(2, 1, 2, 1), (2, 2, 2, 2), (1, 2, 1, 2), (2, 2, 2, 2)][phase]
        look = ([0] * 6 + [1] * 6 + [0] * 6 + [-1] * 6)[i]
        out.append((sprite('open', 0, legs, look), 0 if phase in (1, 3) else -1))
    return out


def done():
    hop = (0, -1, -2, -3, -4, -4, -3, -2, -1, 0, 0, 0)
    out = []
    for i in range(STEPS):
        if i < 12:
            arms = -1 if hop[i] < -1 else 0
            legs = (2, 2, 2, 2) if hop[i] == 0 else (1, 1, 1, 1)
            out.append((sprite('happy', arms, legs), hop[i] * CELL // 2))
        else:
            out.append((sprite('happy' if i < 20 else 'open'), 0))
    return out


def asking():
    return [(sprite('open', -1 if (i // 4) % 2 == 0 else 0), 0) for i in range(STEPS)]


def render(cells):
    """Row r at y = (r + 1) * CELL: the spare row on top is for the hop."""
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for (c, r), col in cells.items():
        y = r * CELL + CELL
        d.rectangle([c * CELL, y, c * CELL + CELL - 1, y + CELL - 1], fill=col)
    return im



# ---- Codex ----
XCELL = 4
XW = XH = 14 * XCELL
XSTEP_MS = (150, 90, 55, 140)
HI = (138, 162, 255)      # cloud highlight
BLUE = (92, 124, 240)     # cloud / body
SHADE = (63, 91, 208)     # underside
SCREEN = (27, 34, 68)     # the face's screen
GLOW = (127, 240, 230)    # terminal glyphs

# The head: a cloud with three bumps on top, rows 0-7.
HEAD = [
    "....HHH.HHH...",
    "..HHBBBHBBBH..",
    ".HBBBBBBBBBBH.",
    "HBBBBBBBBBBBBH",
    "HBBBBBBBBBBBBB",
    "BBBBBBBBBBBBBB",
    "SBBBBBBBBBBBBS",
    ".SSBBBBBBBBSS.",
]
# The screen sits on the face, rows 2-6, cols 3-10 (8 x 5 cells).
SX, SY, SW, SH = 3, 2, 8, 5


def xbase(arms=0, legs=(1, 1)):
    cells = {}
    pal = {'H': HI, 'B': BLUE, 'S': SHADE}
    for r, row in enumerate(HEAD):
        for c, ch in enumerate(row):
            if ch in pal:
                cells[(c, r)] = pal[ch]
    for r in range(SY, SY + SH):
        for c in range(SX, SX + SW):
            cells[(c, r)] = SCREEN
    # Body rows 8-11, cols 4-9; a tiny ">-" on the chest.
    for r in range(8, 12):
        for c in range(4, 10):
            cells[(c, r)] = BLUE if r < 11 else SHADE
    cells[(5, 9)] = GLOW
    cells[(7, 9)] = GLOW
    cells[(8, 9)] = GLOW
    # Arms: one cell each side, rows 9-10, raised one row when arms = -1.
    for r in (9 + arms, 10 + arms):
        cells[(3, r)] = BLUE
        cells[(10, r)] = BLUE
    # Legs: cols 5 and 8, rows 12.. (1 or 2 rows).
    for c, n in zip((5, 8), legs):
        for r in range(12, 12 + n):
            cells[(c, r)] = SHADE
    return cells


def glyphs(cells, marks):
    for c, r in marks:
        cells[(SX + c, SY + r)] = GLOW
    return cells


PROMPT = [(1, 1), (2, 2), (1, 3)]               # ">"
CHECK = [(1, 2), (2, 3), (3, 2), (4, 1), (5, 0)]  # a tick
QUESTION = [(3, 0), (4, 0), (5, 1), (4, 2), (4, 4)]
HAPPY = [(1, 2), (2, 1), (3, 2), (5, 2), (6, 1), (7, 2)]  # ^ ^


def xface(prompt=True, cursor=True, typed=0, extra=()):
    marks = list(PROMPT) if prompt else []
    for i in range(typed):                       # dots typed before the cursor
        marks.append((4 + i, 3))
    if cursor:
        marks += [(4 + typed, 3), (5 + typed, 3)] if 5 + typed < SW else []
    return marks + list(extra)


def xidle():
    out = []
    for i in range(STEPS):
        on = (i // 4) % 2 == 0                   # the cursor blinks
        out.append((glyphs(xbase(), xface(cursor=on)), 1 if i % 12 >= 6 else 0))
    return out


def xworking():
    out = []
    for i in range(STEPS):
        typed = (0, 1, 2, 1)[(i // 3) % 4]       # dots run across and back
        legs = [(1, 2), (1, 1), (2, 1), (1, 1)][(i // 3) % 4]
        out.append((glyphs(xbase(0, legs), xface(typed=typed)), 0 if (i // 3) % 2 else -1))
    return out


def xdone():
    hop = (0, -1, -2, -3, -4, -4, -3, -2, -1, 0, 0, 0)
    out = []
    for i in range(STEPS):
        if i < 12:
            out.append((glyphs(xbase(-1 if hop[i] < -1 else 0), HAPPY), hop[i] * XCELL // 2))
        else:
            out.append((glyphs(xbase(), CHECK), 0))
    return out


def xasking():
    return [(glyphs(xbase(-1 if (i // 4) % 2 == 0 else 0), QUESTION), 0) for i in range(STEPS)]


def xrender(cells):
    """Row r at y = r * XCELL; the hop is the loop's dy, not part of the image."""
    im = Image.new('RGBA', (XW, XH), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    for (c, r), col in cells.items():
        y = r * XCELL
        d.rectangle([c * XCELL, y, c * XCELL + XCELL - 1, y + XCELL - 1], fill=col)
    return im

# ---- Claude's scenes: cooking (working) and headphones (voice listening) ----
SCELL = 8
SCENE_WORK = (26, 22, 110, 12)       # cells wide, cells high, step_ms, steps
SCENE_LISTEN = (24, 24, 140, 8)      # one loop per mic level 0..4, level-major
SCENE_SEND = (26, 26, 120, 12)       # the voice "sending" state: Clawd launches a rocket
LEVELS = 5                           # pets.h HT_PET_SCENE_LEVELS (a _Static_assert in the output holds them)
SOR = (222, 120, 86)      # body
SOR_D = (190, 92, 64)     # shade
SEYE = (16, 16, 16)
HAT = (240, 236, 228)
HAT_D = (214, 208, 198)
PAN = (34, 34, 38)
PAN_L = (70, 70, 78)
FOOD = (250, 200, 60)
NAVY = (22, 38, 84)
SBLUE = (48, 96, 176)
PAD = (220, 220, 214)
NOTE = (250, 204, 90)
WHITE = (236, 236, 232)
GREY = (170, 172, 178)
GLASS = (170, 205, 235)
RED = (226, 60, 40)
FLAME = (250, 190, 50)
FLAME_HOT = (255, 236, 150)


def rect(c, x0, x1, y0, y1, col):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            c[(x, y)] = col


def cooking(t):
    """t: 0..11. Hat, body, a pan held out; three bits tossed from it."""
    c = {}
    bob = 1 if t % 6 in (3, 4, 5) else 0
    lift = 1 if t % 4 in (1, 2) else 0          # the pan flicks up and back
    oy = 6 + bob
    rect(c, 6, 8, oy - 6, oy - 6, HAT); rect(c, 10, 12, oy - 6, oy - 6, HAT)
    rect(c, 4, 14, oy - 5, oy - 3, HAT)
    for x, y in ((5, oy - 4), (9, oy - 5), (13, oy - 4), (8, oy - 3), (11, oy - 3)):
        c[(x, y)] = HAT_D
    rect(c, 5, 13, oy - 2, oy - 1, HAT); rect(c, 5, 13, oy - 1, oy - 1, HAT_D)
    rect(c, 4, 13, oy, oy + 8, SOR); rect(c, 4, 4, oy, oy + 8, SOR_D)
    rect(c, 2, 3, oy + 4, oy + 5, SOR); c[(2, oy + 5)] = SOR_D               # left arm
    rect(c, 14, 15, oy + 4, oy + 5, SOR)                                     # right arm
    for x in (5, 7, 10, 12):
        rect(c, x, x, oy + 9, oy + 10, SOR_D if x in (5, 10) else SOR)
    rect(c, 6, 6, oy + 2, oy + 3, SEYE)
    rect(c, 11, 11, oy + 2, oy + 3, SEYE); c[(11, oy + 1)] = SEYE; c[(12, oy + 1)] = SEYE
    py = oy + 4 - lift
    rect(c, 16, 17, py, py, PAN_L)
    rect(c, 18, 24, py - 1, py - 1, PAN_L); rect(c, 18, 24, py, py, PAN); rect(c, 19, 23, py + 1, py + 1, PAN)
    for x0, ph in ((19, 0), (21, 4), (23, 8)):
        u = (t + ph) % 12
        h = [0, 2, 4, 5, 6, 6, 5, 4, 2, 0, -9, -9][u]
        if h >= 0:
            c[(x0 + (1 if u in (4, 5, 6) else 0), py - 2 - h)] = FOOD
    # One cell right, as the mockup's frame sits: the pan side is the wider one.
    return {(x + 1, y): col for (x, y), col in c.items()}


def listening(t, level):
    """t: 0..7. Headphones, eyes closed, a nod with the beat, notes floating up."""
    c = {}
    nod = [0, 1, 1, 0, 0, 1, 1, 0][t] if level else 0
    oy = 8 + nod
    rect(c, 7, 16, oy, oy, SOR); rect(c, 5, 18, oy + 1, oy + 1, SOR); rect(c, 4, 19, oy + 2, oy + 10, SOR)
    rect(c, 4, 5, oy + 2, oy + 10, SOR_D)
    rect(c, 2, 3, oy + 8, oy + 9, SOR_D); rect(c, 20, 21, oy + 8, oy + 9, SOR)   # arms
    for x in (6, 9, 14, 17):
        rect(c, x, x, oy + 11, oy + 11, SOR_D)
    rect(c, 7, 8, oy + 5, oy + 5, SEYE); rect(c, 15, 16, oy + 5, oy + 5, SEYE)
    c[(7, oy + 6)] = SOR_D; c[(16, oy + 6)] = SOR_D
    rect(c, 7, 16, oy - 3, oy - 3, NAVY); rect(c, 5, 6, oy - 2, oy - 2, NAVY); rect(c, 17, 18, oy - 2, oy - 2, NAVY)
    rect(c, 4, 4, oy - 1, oy + 1, NAVY); rect(c, 19, 19, oy - 1, oy + 1, NAVY)
    rect(c, 7, 16, oy - 2, oy - 2, SBLUE); rect(c, 7, 16, oy - 1, oy - 1, PAD)
    squeeze = 1 if level >= 3 and t % 2 else 0
    for x0 in (2, 19):
        rect(c, x0, x0 + 2, oy + 1, oy + 5, NAVY)
        rect(c, x0 + 1, x0 + 1 + (squeeze if x0 == 2 else -squeeze), oy + 2, oy + 4, SBLUE)
    for k, (x0, ph) in enumerate(((8, 0), (14, 4))):
        u = (t + ph) % 8
        y = oy - 4 - u
        if u < 7:
            c[(x0 + (u % 2), y)] = NOTE; c[(x0 + 1 + (u % 2), y)] = NOTE
            if k == 0:
                c[(x0 + 1 + (u % 2), y - 1)] = NOTE; c[(x0 + 2 + (u % 2), y - 1)] = NOTE
    return c


def sending(t):
    """t: 0..11. Clawd presses the launch button; the rocket shakes, fires and lifts off, then resets."""
    c = {}
    pressed = t in (1, 2, 3)
    # Clawd: body, a raised arm (cheering the launch), the other hand on the box
    rect(c, 2, 11, 13, 20, SOR); rect(c, 2, 2, 13, 20, SOR_D)
    for x, y in ((0, 10), (0, 11), (1, 11), (1, 12), (1, 13)):
        c[(x, y)] = SOR_D if x == 0 else SOR
    rect(c, 12, 13, 17, 17, SOR)
    for x in (3, 5, 8, 10):
        rect(c, x, x, 21, 22, SOR_D if x in (3, 8) else SOR)
    # determined eyes with brows
    rect(c, 4, 4, 15, 16, SEYE); c[(5, 15)] = SEYE
    rect(c, 9, 9, 15, 16, SEYE); c[(8, 15)] = SEYE
    # the launch box and its button, pushed down while pressed
    rect(c, 13, 16, 18, 20, PAN); rect(c, 13, 16, 18, 18, PAN_L)
    rect(c, 14, 15, 17 + (1 if pressed else 0), 17 + (1 if pressed else 0), RED)
    # the rocket: on the pad (shaking) for 0..3, then climbing two cells a frame
    lift = 0 if t < 4 else (t - 3) * 3
    shake = (t % 2) if 1 <= t <= 3 else 0
    rx = 19 + shake
    base = 20 - lift
    def at(x, y, col):
        if 0 <= y:
            c[(x, y)] = col
    for y, (x0, x1) in zip(range(base - 12, base - 9), ((21, 21), (20, 22), (19, 23))):
        for x in range(x0 + shake, x1 + 1 + shake):
            at(x, y, NAVY)
    for y in range(base - 9, base - 1):
        for x in range(rx, rx + 5):
            at(x, y, WHITE)
        at(rx, y, GREY)
    for x in range(rx + 1, rx + 4):                      # a round window: navy ring, glass inside
        for y in range(base - 7, base - 4):
            at(x, y, NAVY)
    at(rx + 2, base - 6, GLASS)
    for y in range(base - 4, base):
        at(rx - 1, y, NAVY); at(rx + 5, y, NAVY)
    at(rx - 2, base - 1, NAVY); at(rx + 6, base - 1, NAVY)
    for x in range(rx + 1, rx + 4):
        at(x, base - 1, PAN)
    # flame: flickers on the pad, long and bright while climbing
    if t >= 1:
        n = 2 if t < 4 else 4
        for k in range(n):
            y = base + k
            w = 1 if k < n - 1 else 0
            for x in range(rx + 2 - w, rx + 3 + w):
                if y < 26:
                    at(x, y, FLAME_HOT if k == 0 else FLAME)
        for k, (dx, dy) in enumerate(((-2, 1), (4, 2), (-1, 3), (5, 0), (0, 4))):
            if (t + k) % 3 == 0 and base + dy < 26:
                at(rx + dx + (t % 2), base + dy, FLAME)
    return c


def cooking_loop():
    return [(cooking(t), 0) for t in range(SCENE_WORK[3])]


def sending_loop():
    return [(sending(t), 0) for t in range(SCENE_SEND[3])]


def listening_loop():
    return [(listening(t, level), 0) for level in range(LEVELS) for t in range(SCENE_LISTEN[3])]


# ---- Codex's scenes: the owner's robot pack (assets/pets/codex, 192 x 208 RGBA frames) ----
# Working = the pack's "running" laptop loop + a bubble of three sandboxes (mockup/codex_options.py W2),
# listening = the wave-only keyframes + a bubble of three bars that follow the mic level (L1, encode.py of
# the pack), sending = the "waving" loop + a paper plane leaving the hand (S2). The robot frames are
# composited over black and quantised per scene (index 0 transparent, cell = 1); the moving bubble or
# plane is a second small sprite, the scene's overlay, drawn after the scene (pets.h ht_pet_overlay_t).
PACK = root / 'assets/pets/codex'
CW, CH = 300, 260                    # the mockup's scene canvas, centred on the glass; the robot sits at RX, RY
RX, RY = (CW - 192) // 2, (CH - 208) // 2 + 6
CX_FILL, CX_LINE, CX_BAR, CX_BAR_HI, CX_QUEUED = '#172d63', '#bceeff', '#74d7ff', '#b6f6ff', '#4a5d9a'
# per scene: pack frames, robot frame per step, step_ms, home-face placement bias (focus.c: working +4, listening -6)
XWORK_STEPS = ([0, 1, 2, 3, 4, 5, 5]) * 4          # running: 120 ms frames, the last one 220 ms = two steps
XWORK_MS, XLISTEN_MS, XSEND_MS = 120, 80, 140
XLISTEN_FRAMES = [0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 3, 3, 3, 3]   # encode.py's keyframes, 60-90 ms rounded to 80
XSEND_STEPS = ([0, 1, 2, 3, 3]) * 3                 # waving: 140 ms frames, the last one 280 ms


def pack_frames(folder, n):
    return [Image.open(PACK / folder / f'{i:02d}.png').convert('RGBA') for i in range(n)]


def canvas():
    return Image.new('RGBA', (CW, CH), (0, 0, 0, 0))


def bubble(d, x, y, w, h):
    d.rounded_rectangle((x, y, x + w, y + h), radius=9, fill=CX_FILL, outline=CX_LINE, width=2)
    d.polygon([(x + 6, y + h - 2), (x - 3, y + h + 6), (x + 13, y + h)], fill=CX_FILL)
    d.line([(x + 6, y + h), (x - 3, y + h + 6), (x + 9, y + h + 1)], fill=CX_LINE, width=2)


def tick(d, cx, cy, s):
    d.line([(cx - 7 * s, cy), (cx - 2 * s, cy + 5 * s), (cx + 8 * s, cy - 6 * s)], fill=CX_FILL, width=2)


def work_overlay(step):
    """Cycle k (0..3) per loop: sandboxes < k done, k running (blinking each frame), the rest queued."""
    cycle, i = divmod(step, 7)
    i = min(i, 5)                                    # the running frame this step shows
    im = canvas()
    d = ImageDraw.Draw(im)
    bx, by = RX + 158, RY + 22
    bubble(d, bx, by, 70, 40)
    for k in range(3):
        x = bx + 9 + k * 19
        if k < cycle:
            d.rounded_rectangle((x, by + 13, x + 14, by + 27), radius=3, fill=CX_BAR)
            tick(d, x + 7, by + 20, 0.6)
        elif k == cycle:
            d.rounded_rectangle((x, by + 13, x + 14, by + 27), radius=3, outline=CX_BAR, width=2,
                                fill=CX_BAR_HI if i % 2 == 0 else CX_FILL)
        else:
            d.rounded_rectangle((x, by + 13, x + 14, by + 27), radius=3, outline=CX_QUEUED, width=2)
    return im


def listen_overlay(level, step):
    """The bubble with three bars: 9 px flat at level 0, the pack's full 9 + 19 * a swing at level 4."""
    im = canvas()
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((RX + 171, RY + 37, RX + 226, RY + 85), radius=9, fill=CX_FILL, outline=CX_LINE, width=2)
    d.polygon([(RX + 177, RY + 83), (RX + 168, RY + 91), (RX + 184, RY + 85)], fill=CX_FILL)
    d.line([(RX + 177, RY + 85), (RX + 168, RY + 91), (RX + 180, RY + 86)], fill=CX_LINE, width=2)
    for j, x in enumerate((184, 195, 206)):
        a = (math.sin(2 * math.pi * step * XLISTEN_MS / 1200 + j * 1.2) + 1) / 2
        h = round(9 + 19 * a * level / (LEVELS - 1))
        y = 61 - h // 2
        d.rounded_rectangle((RX + x, RY + y, RX + x + 7, RY + y + h), radius=3,
                            fill=(CX_BAR, CX_BAR_HI, CX_BAR)[j])
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


def cell_frames(prefix, items, palette_name):
    """C definitions of de-duplicated cell frames; returns (code, index per item, count, bytes)."""
    code, seen, refs, order = [], {}, [], []
    for cols, rows, grid in items:
        key = (cols, rows, tuple(grid))
        if key not in seen:
            seen[key] = len(refs)
            code.append(f'static const uint8_t {prefix}_c{len(refs)}[{cols * rows}] = {{' + ','.join(map(str, grid)) + '};\n')
            refs.append(f'{{{cols},{rows},1,{palette_name},{prefix}_c{len(refs)}}}')
        order.append(seen[key])
    code.append(f'static const ht_cell_frame_t {prefix}_frames[{len(refs)}] = {{' + ','.join(refs) + '};\n')
    return code, order, len(refs), sum(c * r for c, r, _ in seen)


def generate_pack_scene(prefix, kind):
    """One Codex scene from the pack: robot frames + overlay, in the ht_pet_scene_t layout (pets.h)."""
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
    if kind == 'work':
        images = [work_overlay(s) for s in range(steps)]
    elif kind == 'listen':
        images = [listen_overlay(lv, s) for lv in range(levels) for s in range(steps)]
    else:
        images = [send_overlay(s, steps) for s in range(steps)]
    shapes, opal = exact_overlay(images)
    ov = prefix + '_ov'
    out.append(f'static const uint16_t {ov}_pal[{len(opal)}] = {{' + ','.join(str(0 if k == 0 else rgb565_panel(c)) for k, c in enumerate(opal)) + '};\n')
    code, oorder, on, obytes = cell_frames(ov, [(c, r, g) for c, r, g, _ in shapes], f'{ov}_pal')
    out += code
    out.append(f'static const uint8_t {ov}_loop[{len(oorder)}] = {{' + ','.join(map(str, oorder)) + '};\n')
    # at: where each step's frame sits from the scene's origin (the robot's ink box), in px.
    at = [(x - RX - box[0], y - RY - box[1]) if (x or y) else (0, 0) for *_, (x, y) in shapes]
    out.append(f'static const int16_t {ov}_at[{len(at)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in at) + '};\n')
    out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
    # The sprite's home-face place is the mockup's: the robot at (RX, RY) in the canvas centred on the glass.
    x0, y0 = (466 - CW) // 2 + RX + box[0], (466 - CH) // 2 + RY + box[1]
    dx, dy = x0 - (466 - w) // 2, y0 - (233 - h // 2 + bias)
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{steps},{step_ms},&{ov},{dx},{dy}}};\n')
    return out, n + on, nbytes + obytes + (len(palette) + len(opal)) * 2


# ---- Muse Code's Jolly: PNG frames (assets/pets/muse, straight alpha, device scale) ----
MUSE = root / 'assets/pets/muse'
MUSE_SCENES = json.loads((MUSE / 'scenes.json').read_text())
MUSE_FLY = json.loads((MUSE / 'send.json').read_text())
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
    frames = muse_frames('rest')
    box = union_box(frames)
    out = []
    for f in frames:
        rgb = Image.alpha_composite(Image.new('RGBA', f.size, (0, 0, 0, 255)), f).convert('RGB')
        im = rgb.convert('RGBA')
        im.putalpha(f.getchannel('A'))
        out.append(im.crop(box))
    return out


def muse_pet_states():
    """One waving loop for idle / working / done / asking; identical frames stored once."""
    ims = muse_rest_images()
    seen, index = {}, []
    for i, im in enumerate(ims):
        index.append(seen.setdefault(im.tobytes(), i))
    loop = [({'i': index[i]}, 0) for i in range(STEPS)]
    assert len(ims) == STEPS
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
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{steps},{meta["step_ms"]},{ov_ref},{dx},{dy}}};\n')
    return out, n + extra, nbytes + obytes + len(palette) * 2


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
PETS = (
    ('claude', 'claude', (W, H), (idle, working, done, asking), render, STEP_MS),
    ('codex', 'codex', (XW, XH), (xidle, xworking, xdone, xasking), xrender, XSTEP_MS),
    ('muse', 'muse', MUSE_SIZE, MUSE_STATES, muse_render, (MUSE_REST_MS,) * 4),
)


def generate_pet(prefix, states, draw):
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
    for n, cells in enumerate(frames):
        code, ref = emit(f'{prefix}{n}', draw(cells))
        out.append(code)
        refs.append(ref)
    return out, refs, loops


def generate_scene(prefix, loop, size, step_ms, steps, levels):
    """One scene as CELL GRIDS: per de-duplicated frame cols x rows bytes (a palette index, 0 transparent;
    cells outside the grid are dropped, as the mockup's sprite() does), one RGB565 panel-order palette,
    the flat loop of frame indices and the ht_pet_scene_t that points at them."""
    cols, rows = size
    colours, frames, index, steps_out = {}, [], {}, []
    for cells, _ in loop():
        grid = {p: c for p, c in cells.items() if 0 <= p[0] < cols and 0 <= p[1] < rows}
        key = tuple(sorted(grid.items()))
        if key not in index:
            index[key] = len(frames)
            frames.append(grid)
        steps_out.append(index[key])
    for col in sorted({c for g in frames for c in g.values()}):
        colours[col] = len(colours) + 1
    assert len(colours) < 256
    out = []
    pal = [0] + [rgb565_panel(c) for c in colours]
    out.append(f'static const uint16_t {prefix}_pal[{len(pal)}] = {{' + ','.join(map(str, pal)) + '};\n')
    refs = []
    for n, grid in enumerate(frames):
        data = [grid[(x, y)] if (x, y) in grid else None for y in range(rows) for x in range(cols)]
        out.append(f'static const uint8_t {prefix}_c{n}[{cols * rows}] = {{'
                   + ','.join(str(colours[v]) if v else '0' for v in data) + '};\n')
        refs.append(f'{{{cols},{rows},{SCELL},{prefix}_pal,{prefix}_c{n}}}')
    out.append(f'static const ht_cell_frame_t {prefix}_frames[{len(refs)}] = {{' + ','.join(refs) + '};\n')
    out.append(f'static const uint8_t {prefix}_loop[{len(steps_out)}] = {{' + ','.join(map(str, steps_out)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {steps} * {"HT_PET_SCENE_LEVELS" if levels > 1 else 1}, "{prefix}: steps x levels");\n')
    assert len(steps_out) == steps * levels
    out.append(f'static const ht_pet_scene_t {prefix} = {{{cols * SCELL},{rows * SCELL},{prefix}_frames,'
               f'{prefix}_loop,{steps},{step_ms},NULL,0,0}};\n')
    return out, len(refs), len(refs) * cols * rows + len(pal) * 2


# engine -> (working scene, listening scene, sending scene): prefix, loop, size in cells, step_ms, steps; levels
# (Codex's: prefix and kind, generate_pack_scene)
SCENES = {
    'claude': (('claude_work', cooking_loop, SCENE_WORK, 1),
               ('claude_listen', listening_loop, SCENE_LISTEN, LEVELS),
               ('claude_send', sending_loop, SCENE_SEND, 1)),
    'codex': (('codex_work', 'work'), ('codex_listen', 'listen'), ('codex_send', 'send')),
    'muse': (('muse_work', 'mwork'), ('muse_listen', 'mlisten'), ('muse_send', 'msend')),
}


def generate():
    out = ['// Generated by scripts/gen_pets.py. Do not edit.\n'
           '// The pets: per engine the de-duplicated frames and the idle/working/done/asking loops.\n'
           '#include "pets.h"\n']
    table, counts, scene_stats = [], [], []
    for engine, prefix, (w, h), states, draw, step_ms in PETS:
        code, refs, loops = generate_pet(prefix, states, draw)
        out += code
        counts.append(len(refs))
        out.append(f'static const ht_icon_t {prefix}_frames[{len(refs)}] = {{' + ','.join(refs) + '};\n')
        rows = ['{' + ','.join(f'{{{f},{dy}}}' for f, dy in steps) + '}' for steps in loops]
        out.append(f'static const ht_pet_step_t {prefix}_loops[HT_PET_STATES][HT_PET_STEPS] = {{' + ','.join(rows) + '};\n')
        out.append(f'static const uint16_t {prefix}_step_ms[HT_PET_STATES] = {{' + ','.join(map(str, step_ms)) + '};\n')
        refs_to = []
        for spec in SCENES.get(engine, (None, None, None)):
            if not spec:
                refs_to.append('NULL')
                continue
            if spec[1] in ('mwork', 'mlisten', 'msend'):
                sprefix = spec[0]
                code, n, nbytes = generate_muse_scene(sprefix, spec[1][1:])
            elif spec[1] in ('work', 'listen', 'send'):
                sprefix = spec[0]
                code, n, nbytes = generate_pack_scene(sprefix, spec[1])
            else:
                sprefix, loop, (cw, ch, sms, steps), levels = spec
                code, n, nbytes = generate_scene(sprefix, loop, (cw, ch), sms, steps, levels)
            out += code
            scene_stats.append((sprefix, n, nbytes))
            refs_to.append('&' + sprefix)
        table.append(f'{{"{engine}",{w},{h},{prefix}_frames,{prefix}_loops,{prefix}_step_ms,{",".join(refs_to)}}}')
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
    for (engine, _, (w, h), *_), n in zip(PETS, counts):
        print(f'{engine}: {n} frames, {n * w * h * 3} bytes')
    for name, n, nbytes in scene_stats:
        print(f'{name}: {n} frames, {nbytes} bytes')
    print(f'wrote {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
