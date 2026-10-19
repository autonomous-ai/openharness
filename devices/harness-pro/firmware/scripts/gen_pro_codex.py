#!/usr/bin/env python3
"""Codex pet in HD -> main/pod/pets_codex.c (pod_codex_pet). Frames come from assets/codex/hd (upscale_codex.py,
K = hd/K.txt times the 192 x 208 source); overlays are drawn at 4K and Lanczos-downsampled. Every pixel is composited
over the room ground and given alpha 255 (source alpha >= ALPHA_CUT) or 0, then quantised per scene with
Floyd-Steinberg dither. Timings, loops and levels are the round dial's. Usage: python3 scripts/gen_pro_codex.py [--check]"""
import math
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageColor, ImageDraw

root = Path(__file__).resolve().parents[1]
HD = root / 'assets/codex/hd'
OUT = root / 'main/pod/pets_codex.c'
K = float((HD / 'K.txt').read_text())
BG = (0x22, 0x1F, 0x1D)                    # PH_ROOM_BG
ALPHA_CUT = 24
LEVELS = 5                                 # HT_PET_SCENE_LEVELS
STEPS = 24                                 # HT_PET_STEPS
OS = 4                                     # overlay supersampling


def k(v):
    return round(v * K)


# ---- small pet: idle (blinks), review (done), waiting (asking); 24 steps over each pack loop ----
LOOPS = {'idle': (280, 110, 110, 140, 140, 320), 'review': (150, 150, 150, 150, 150, 280),
         'waiting': (150, 150, 150, 150, 150, 260)}
STATE_LOOPS = ('idle', 'idle', 'review', 'waiting')            # idle, working, done, asking (step_ms only: Pod plays idle and asking)
PLAYED = (0, 3)                            # HT_PET_IDLE, HT_PET_ASKING; the other rows are {0,0}, as scripts/prune_pets.py leaves them
SMALL_SIZE = (44, 56)                      # ht_pet_t w, h: the 1x size

# ---- scenes: working = running loop, listening = keyframes + bubble with code-drawn bars, sending = waving + plane ----
CW, CH = 300, 260                          # the 1x scene canvas the robot sits in, at RX, RY
RX, RY = (CW - 192) // 2, (CH - 208) // 2 + 6
CX_FILL, CX_LINE, CX_BAR, CX_BAR_HI = '#172d63', '#bceeff', '#74d7ff', '#b6f6ff'
WORK_STEPS = [0, 1, 2, 3, 4, 5, 5] * 4
LISTEN_FRAMES = [0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 3, 3, 3, 3]
SEND_STEPS = [0, 1, 2, 3, 3] * 3
ASK_STEPS = [0, 1, 2, 3, 3] * 2           # the asking look (Agent room): the same waving frames, no plane; pod_codex_ask shares pxc_send's frames and palette
WORK_MS, LISTEN_MS, SEND_MS = 120, 80, 140     # (the ask scene steps at SEND_MS too)
BAR_X, BAR_W, BAR_CY, BAR_RADIUS, BAR_MIN, BAR_SWING = (184, 195, 206), 7, 61, 3, 9, 19   # 1x, from the robot frame
BAR_PERIOD_MS, BAR_PHASE = 1200, 1.2

# ---- relax: the paper plane laps the robot (1x glass coordinates) ----
RELAX_N, RELAX_MS = 24, 120
GLASS = 466
XROBOT_AT = (233 - 96, 234 - 104)
XHAND = (XROBOT_AT[0] + 34, XROBOT_AT[1] + 120)
XLOOP = dict(cx=240, cy=214, rx=124, ry=44)
XTHROW, XCATCH = 3, 19


def load(folder, n):
    return [Image.open(HD / folder / f'{i:02d}.png').convert('RGBA') for i in range(n)]


def prep(im):
    """Over the room ground; alpha 255 where the source's is >= ALPHA_CUT, else 0."""
    a = im.getchannel('A').point(lambda v: 255 if v >= ALPHA_CUT else 0)
    out = Image.alpha_composite(Image.new('RGBA', im.size, BG + (255,)), im)
    out.putalpha(a)
    return out


def ink_box(frames):
    boxes = [f.getchannel('A').getbbox() for f in frames]
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def quantise(pieces):
    """RGBA pieces (prep'd, any sizes): per piece a grid of palette indices (1..), 0 where transparent; one
    <= 255 colour palette (index 0 = transparent) for all, Floyd-Steinberg dithered."""
    flat = [p.convert('RGB') for p in pieces]
    strip = Image.new('RGB', (sum(f.width for f in flat), max(f.height for f in flat)), BG)
    x = 0
    for f in flat:
        strip.paste(f, (x, 0))
        x += f.width
    pal = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    rgb = pal.getpalette()
    grids, used = [], {}
    for f, src in zip(flat, pieces):
        q = f.quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG)
        grid = []
        for qv, a in zip(q.get_flattened_data(), src.getchannel('A').get_flattened_data()):
            if not a:
                grid.append(0)
                continue
            used.setdefault(qv, len(used) + 1)
            grid.append(used[qv])
        grids.append(grid)
    palette = [(0, 0, 0)] + [tuple(rgb[3 * c:3 * c + 3]) for c in sorted(used, key=used.get)]
    assert len(palette) <= 256
    return grids, palette


def overlay_shapes(images):
    """Overlay images (prep'd): per image its bbox crop as (cols, rows, grid, (x, y)), one shared palette; a 1 x 1
    transparent cell (position None) for an empty image."""
    boxes = [im.getchannel('A').getbbox() for im in images]
    grids, palette = quantise([im.crop(b) for im, b in zip(images, boxes) if b] or [Image.new('RGBA', (1, 1))])
    it, out = iter(grids), []
    for im, b in zip(images, boxes):
        out.append((b[2] - b[0], b[3] - b[1], next(it), (b[0], b[1])) if b else (1, 1, [0], None))
    return out, palette


def rgb565(rgb):
    r, g, b = rgb
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def rgb565_panel(rgb):
    v = rgb565(rgb)
    return ((v << 8) | (v >> 8)) & 0xFFFF


def pal_code(name, palette):
    return f'static const uint16_t {name}[{len(palette)}] = {{' + ','.join(str(0 if i == 0 else rgb565_panel(c)) for i, c in enumerate(palette)) + '};\n'


def pack_rows(cols, rows, grid):
    """Per row (skip, count) byte pairs each followed by `count` indices; and each row's start. Fails when the
    packed bytes would not be addressable by the uint16 row_at (a frame that small is unpacked anyway)."""
    assert cols <= 480 and rows <= 65535     # HT_CELL_COLS_MAX
    out, at = [], []
    for r in range(rows):
        at.append(len(out))
        row, x = grid[r * cols:(r + 1) * cols], 0
        while x < cols:
            skip = 0
            while x < cols and not row[x] and skip < 255:
                skip += 1; x += 1
            run = []
            while x < cols and row[x] and len(run) < 255:
                run.append(row[x]); x += 1
            out += [skip, len(run)] + run
    if len(out) >= 65536:
        raise ValueError(f'{cols} x {rows} frame packs to {len(out)} bytes: row_at is uint16, split the frame or widen it')
    return out, at


def cell_frames(prefix, items, palette_name):
    """C definitions of de-duplicated cell frames (packed when smaller); returns (code, index per item, count, bytes)."""
    code, seen, refs, order, nbytes = [], {}, [], [], 0
    for cols, rows, grid in items:
        key = (cols, rows, tuple(grid))
        if key not in seen:
            seen[key] = n = len(refs)
            packed, at = pack_rows(cols, rows, grid)
            if len(packed) + 2 * rows < cols * rows:
                code.append(f'static const uint8_t {prefix}_c{n}[{len(packed)}] = {{' + ','.join(map(str, packed)) + '};\n')
                code.append(f'static const uint16_t {prefix}_r{n}[{rows}] = {{' + ','.join(map(str, at)) + '};\n')
                refs.append(f'{{{cols},{rows},1,{palette_name},{prefix}_c{n},{prefix}_r{n}}}')
                nbytes += len(packed) + 2 * rows
            else:
                code.append(f'static const uint8_t {prefix}_c{n}[{cols * rows}] = {{' + ','.join(map(str, grid)) + '};\n')
                refs.append(f'{{{cols},{rows},1,{palette_name},{prefix}_c{n},NULL}}')
                nbytes += cols * rows
        order.append(seen[key])
    code.append(f'static const ht_cell_frame_t {prefix}_frames[{len(refs)}] = {{' + ','.join(refs) + '};\n')
    return code, order, len(refs), nbytes


def emit_overlay(prefix, shapes, opal, origin, copies=1):
    """The overlay's palette, frames, loop and `at` (from the scene origin = the robot ink box's top-left, `origin`)."""
    ov = prefix + '_ov'
    code, order, n, nbytes = cell_frames(ov, [(c, r, g) for c, r, g, _ in shapes], f'{ov}_pal')
    out = [pal_code(f'{ov}_pal', opal)] + code
    order, shapes = order * copies, shapes * copies
    at = [(0, 0) if pos is None else (pos[0] - origin[0], pos[1] - origin[1]) for *_, pos in shapes]
    out.append(f'static const uint8_t {ov}_loop[{len(order)}] = {{' + ','.join(map(str, order)) + '};\n')
    out.append(f'static const int16_t {ov}_at[{len(at)}][2] = {{' + ','.join(f'{{{x},{y}}}' for x, y in at) + '};\n')
    out.append(f'static const ht_pet_overlay_t {ov} = {{{ov}_frames,{ov}_loop,{ov}_at}};\n')
    return out, n, nbytes + len(opal) * 2


class Canvas:
    """A transparent canvas of `size` HD px drawn at OS x; `at(x, y)` maps 1x coordinates (origin ox, oy) of the
    robot, which sits at (rx, ry) HD px, to canvas px."""
    def __init__(self, size, o1x, ohd):
        self.size, self.o1x, self.ohd = size, o1x, ohd
        self.im = Image.new('RGBA', (size[0] * OS, size[1] * OS), (0, 0, 0, 0))
        self.d = ImageDraw.Draw(self.im)
        self.s = K * OS

    def at(self, x, y):
        return ((x - self.o1x[0]) * K + self.ohd[0]) * OS, ((y - self.o1x[1]) * K + self.ohd[1]) * OS

    def poly(self, pts, fill, line=None):
        pts = [self.at(*p) for p in pts]
        self.d.polygon(pts, fill=fill)
        if line:
            self.d.line(pts + [pts[0]], fill=line, width=round(self.s), joint='curve')

    def out(self):
        return self.im.resize(self.size, Image.LANCZOS)


def scene_canvas(size, rx, ry):
    return Canvas(size, (RX, RY), (rx, ry))


def listen_bubble(c):
    """The bubble without its bars (they are drawn in code)."""
    x0, y0 = c.at(RX + 171, RY + 37)
    x1, y1 = c.at(RX + 227, RY + 86)
    c.d.rounded_rectangle((x0, y0, x1 - 1, y1 - 1), radius=9 * c.s, fill=CX_FILL, outline=CX_LINE, width=round(2 * c.s))
    c.poly([(RX + 177, RY + 83), (RX + 168, RY + 91), (RX + 184, RY + 85)], CX_FILL)
    c.d.line([c.at(RX + 177, RY + 85), c.at(RX + 168, RY + 91), c.at(RX + 180, RY + 86)], fill=CX_LINE, width=round(2 * c.s), joint='curve')


def plane(c, x, y, ang, s):
    """The paper plane (nose at +x) at (x, y) 1x, turned by `ang` about its centre and scaled by `s`."""
    cs, sn = math.cos(ang), math.sin(ang)

    def T(pts):
        return [(x + ((px - 15) * cs - (py - 9) * sn) * s, y + ((px - 15) * sn + (py - 9) * cs) * s) for px, py in pts]
    c.poly(T([(0, 10), (30, 0), (12, 18)]), CX_BAR_HI, CX_LINE)
    c.poly(T([(12, 18), (30, 0), (15, 11)]), CX_BAR)


def send_overlay(c, step, steps):
    t = step / (steps - 1)
    x, y = RX + 40 - t * 30 + t * t * 230, RY + 70 - t * 95
    s = 1.0 - 0.3 * t
    if t < 0.95:
        c.poly([(x, y + 10 * s), (x + 30 * s, y), (x + 12 * s, y + 18 * s)], CX_BAR_HI, CX_LINE)
        c.poly([(x + 12 * s, y + 18 * s), (x + 30 * s, y), (x + 15 * s, y + 11 * s)], CX_BAR)
        for j in range(1, 5):
            tx, ty = x - j * 9 + j * j * 1.5, y + 12 + j * 7
            if j % 2:
                (cx, cy), r = c.at(tx, ty), 2 * c.s
                c.d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=CX_BAR)


def scene(prefix, kind):
    """One scene: robot frames + overlay (none while working), in the ht_pet_scene_t layout."""
    folder, n, seq, ms, levels = {'work': ('running', 6, WORK_STEPS, WORK_MS, 1),
                                  'listen': ('listening', 4, LISTEN_FRAMES, LISTEN_MS, LEVELS),
                                  'send': ('waving', 4, SEND_STEPS, SEND_MS, 1)}[kind]
    raw = load('scene/' + folder, n)
    rx, ry = k(RX), k(RY)
    frames = [prep(f) for f in raw]
    box = ink_box(frames)
    w, h = box[2] - box[0], box[3] - box[1]
    grids, palette = quantise([f.crop(box) for f in frames])
    out = [pal_code(f'{prefix}_pal', palette)]
    code, order, nf, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    loop = [order[i] for _ in range(levels) for i in seq]
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {len(seq)} * {"HT_PET_SCENE_LEVELS" if levels > 1 else 1}, "{prefix}: steps x levels");\n')
    nbytes += len(palette) * 2
    ovref, bars = 'NULL', 'NULL'
    if kind != 'work':
        size = (k(CW), k(CH))
        if kind == 'listen':
            c = scene_canvas(size, rx, ry); listen_bubble(c); imgs = [prep(c.out())]
        else:
            imgs = []
            for s in range(len(seq)):
                c = scene_canvas(size, rx, ry); send_overlay(c, s, len(seq)); imgs.append(prep(c.out()))
        shapes, opal = overlay_shapes(imgs)
        o, on, ob = emit_overlay(prefix, shapes, opal, (rx + box[0], ry + box[1]), levels * len(seq) if kind == 'listen' else 1)
        out += o
        nf, nbytes, ovref = nf + on, nbytes + ob, f'&{prefix}_ov'
    if kind == 'listen':
        fills = ','.join(str(rgb565(ImageColor.getrgb(col))) for col in (CX_BAR, CX_BAR_HI, CX_BAR))
        out.append(f'static const ht_pet_bars_t {prefix}_bars = {{{{{",".join(str(k(x) - box[0]) for x in BAR_X)}}},{k(BAR_CY) - box[1]},'
                   f'{k(BAR_W + 1)},{k(BAR_RADIUS)},{k(BAR_MIN)},{k(BAR_SWING)},{{{fills}}},{BAR_PERIOD_MS},{BAR_PHASE}f}};\n')
        bars = f'&{prefix}_bars'
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{len(seq)},{ms},{ovref},0,0,{bars},NULL,NULL,NULL,NULL}};\n')
    if kind == 'send':
        ask = [order[i] for i in ASK_STEPS]
        out.append(f'static const uint8_t pxc_ask_loop[{len(ask)}] = {{' + ','.join(map(str, ask)) + '};\n')
        out.append(f'const ht_pet_scene_t pod_codex_ask = {{{w},{h},{prefix}_frames,pxc_ask_loop,{len(ask)},{ms},NULL,0,0,NULL,NULL,NULL,NULL,NULL}};\n')
    return out, nf, nbytes


def relax_loop_at(kk):
    """The plane at kk (0 at the hand .. 1 back at it): one lap of an ellipse round the robot; depth < 0 behind it."""
    a = math.pi + 2 * math.pi * kk
    ex, ey = XLOOP['cx'] + XLOOP['rx'] * math.cos(a), XLOOP['cy'] + XLOOP['ry'] * math.sin(a)
    w = math.sin(math.pi * kk) ** 0.5
    return XHAND[0] + (ex - XHAND[0]) * w, XHAND[1] + (ey - XHAND[1]) * w, math.sin(a)


def relax_step(n, wave, idle, rx, ry):
    """The robot frame and the plane's overlay image (both glass-sized, prep'd) at step n."""
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
    size = (k(GLASS), k(GLASS))
    c = Canvas(size, XROBOT_AT, (rx, ry))
    if XTHROW < n < XCATCH:
        kk = (n - XTHROW) / (XCATCH - XTHROW)
        x, y, depth = relax_loop_at(kk)
        (bx, by, _), (fx, fy, _) = relax_loop_at(max(0, kk - 0.01)), relax_loop_at(min(1, kk + 0.01))
        for j in range(2, 9):                          # the dotted trail, thinning out
            k2 = kk - j * 0.02
            if k2 <= 0:
                break
            tx, ty, td = relax_loop_at(k2)
            (px, py), r = c.at(tx, ty), (2.6 if td > 0 else 2.0) * (1 - j / 11) * c.s
            c.d.ellipse((px - r, py - r, px + r, py + r), fill=CX_BAR)
        plane(c, x, y, math.atan2(fy - by, fx - bx), 1.35 + 0.3 * depth)
    else:                                              # in the hand, nose up and out
        plane(c, XHAND[0] - 2, XHAND[1] - 14, -1.1, 1.25)
    props = c.out()
    if XTHROW < n < XCATCH and depth < 0:             # behind the robot: hidden where its ink is
        body = Image.new('RGBA', size, (0, 0, 0, 0))
        body.alpha_composite(robot, (rx, ry))
        hide = body.getchannel('A').point(lambda v: 255 if v >= ALPHA_CUT else 0)
        props.putalpha(ImageChops.subtract(props.getchannel('A'), hide))
    return robot, prep(props)


def relax(prefix):
    wave, idle = load('scene/waving', 4), load('scene/idle', 6)
    rx, ry = k(XROBOT_AT[0]), k(XROBOT_AT[1])
    steps = [relax_step(n, wave, idle, rx, ry) for n in range(RELAX_N)]
    robots = [wave[1], wave[2], idle[0], idle[1]]
    pr = [prep(r) for r in robots]
    box = ink_box(pr)
    w, h = box[2] - box[0], box[3] - box[1]
    grids, palette = quantise([p.crop(box) for p in pr])
    out = [pal_code(f'{prefix}_pal', palette)]
    code, order, n, nbytes = cell_frames(prefix, [(w, h, g) for g in grids], f'{prefix}_pal')
    out += code
    loop = [order[next(i for i, r in enumerate(robots) if r is robot)] for robot, _ in steps]
    out.append(f'static const uint8_t {prefix}_loop[{len(loop)}] = {{' + ','.join(map(str, loop)) + '};\n')
    out.append(f'_Static_assert(sizeof {prefix}_loop == {RELAX_N}, "{prefix}: steps");\n')
    shapes, opal = overlay_shapes([p for _, p in steps])
    o, on, ob = emit_overlay(prefix, shapes, opal, (rx + box[0], ry + box[1]))
    out += o
    out.append(f'static const ht_pet_scene_t {prefix} = {{{w},{h},{prefix}_frames,{prefix}_loop,{RELAX_N},{RELAX_MS},&{prefix}_ov,0,0,NULL,NULL,NULL,NULL,NULL}};\n')
    return out, n + on, nbytes + ob + len(palette) * 2


def small_pet(prefix):
    names = list(LOOPS)
    raw = {(st, i): prep(Image.open(HD / 'small' / st / f'{i:02d}.png').convert('RGBA')) for st in names for i in range(6)}
    loops, step_ms, used = [], [], []
    for si, st in enumerate(STATE_LOOPS):
        times = LOOPS[st]
        each = round(sum(times) / STEPS)
        steps = []
        for i in range(STEPS):
            t, kk = i * each, 0
            while kk < 5 and t >= sum(times[:kk + 1]):
                kk += 1
            if si in PLAYED and (st, kk) not in used:
                used.append((st, kk))
            steps.append((st, kk) if si in PLAYED else None)
        loops.append(steps)
        step_ms.append(each)
    imgs = [raw[u] for u in used]
    grids, palette = quantise(imgs)
    out = [pal_code(f'{prefix}_pal', palette)]
    code, order, n, nbytes = cell_frames(prefix, [(im.width, im.height, g) for im, g in zip(imgs, grids)], f'{prefix}_pal')
    out += code
    rows = ['{' + ','.join('{0,0}' if s is None else f'{{{order[used.index(s)]},0}}' for s in steps) + '}' for steps in loops]
    out.append(f'static const ht_pet_step_t {prefix}_loops[HT_PET_STATES][HT_PET_STEPS] = {{' + ','.join(rows) + '};\n')
    out.append(f'static const uint16_t {prefix}_step_ms[HT_PET_STATES] = {{' + ','.join(map(str, step_ms)) + '};\n')
    return out, n, nbytes + len(palette) * 2


def generate():
    out = ['// Generated by scripts/gen_pro_codex.py. Do not edit.\n#include "pets.h"\n']
    stats = []
    for name, gen in (('pxc', small_pet), ('pxc_work', lambda p: scene(p, 'work')), ('pxc_listen', lambda p: scene(p, 'listen')),
                      ('pxc_send', lambda p: scene(p, 'send')), ('pxc_relax', relax)):
        code, n, nbytes = gen(name)
        out += code
        stats.append((name, n, nbytes))
    w, h = SMALL_SIZE
    out.append(f'const ht_pet_t pod_codex_pet = {{"codex",{w},{h},NULL,pxc_loops,pxc_step_ms,&pxc_work,&pxc_listen,&pxc_send,'
               f'pxc_frames,NULL,0,&pxc_relax,NULL}};\n')
    return ''.join(out), stats


def main():
    text, stats = generate()
    if '--check' in sys.argv:
        sys.exit(0 if OUT.exists() and OUT.read_text() == text else 'main/pod/pets_codex.c is stale: run scripts/gen_pro_codex.py')
    OUT.write_text(text)
    for name, n, nbytes in stats:
        print(f'{name:12s} {n:3d} frames {nbytes:8d} bytes')
    print(f'total        {sum(s[2] for s in stats):8d} bytes')


if __name__ == '__main__':
    main()
