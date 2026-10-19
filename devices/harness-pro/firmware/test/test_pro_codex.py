#!/usr/bin/env python3
"""main/pod/pets_codex.c (scripts/gen_pro_codex.py): scene timings, palettes, size, bars inside the bubble, and the
relax plane hidden behind the robot."""
import importlib.util, math, re, sys
from pathlib import Path

fw = Path(__file__).resolve().parents[1]
src = (fw / 'main/pod/pets_codex.c').read_text()

arrays = {m[0]: [int(v) for v in re.sub(r'[{}]', ' ', m[1]).replace(',', ' ').split()] for m in
          re.findall(r'static const u?int\d+_t (\w+)\[[^\]]*\](?:\[2\])? = \{(.*?)\};\n', src)}


def scene(name):
    m = re.search(rf'ht_pet_scene_t {name} = \{{(\d+),(\d+),\w+,(\w+),(\d+),(\d+),', src)
    return int(m[1]), int(m[2]), m[3], int(m[4]), int(m[5])


def frames(name):
    body = re.search(rf'ht_cell_frame_t {name}_frames\[\d+\] = \{{(.*)\}};', src).group(1)
    return [tuple(int(v) if v.isdigit() else v for v in f.split(',')) for f in re.findall(r'\{([^{}]*)\}', body)]


def ink(name, i):
    """The inked (col, row) cells of frame i of the scene/overlay `name`, from the RLE (or raw) cells."""
    cols, rows, _, _, cells, row_at = frames(name)[i]
    data, out = arrays[cells], set()
    for r in range(rows):
        if row_at == 'NULL':
            out |= {(c, r) for c in range(cols) if data[r * cols + c]}
            continue
        p, x = arrays[row_at][r], 0
        while x < cols:
            skip, n = data[p], data[p + 1]
            out |= {(x + skip + j, r) for j in range(n) if data[p + 2 + j]}
            x += skip + n
            p += 2 + n
    return out


# steps x step_ms
for name, steps, ms, levels in (('pxc_work', 28, 120, 1), ('pxc_listen', 15, 80, 5), ('pxc_send', 15, 140, 1), ('pxc_relax', 24, 120, 1)):
    w, h, loop, n, t = scene(name)
    assert (n, t) == (steps, ms), (name, n, t)
    assert len(arrays[loop]) == steps * levels, (name, len(arrays[loop]))
w, h, loop, n, t = scene('pod_codex_ask')   # the asking look: pxc_send's waving frames (no copy of the pixels), [0,1,2,3,3] x 2
assert (n, t) == (10, 140) and loop == 'pxc_ask_loop' and (w, h) == scene('pxc_send')[:2], (n, t, loop)
assert re.search(r'ht_pet_scene_t pod_codex_ask = \{\d+,\d+,pxc_send_frames,pxc_ask_loop,10,140,NULL,', src)
sl = arrays[scene('pxc_send')[2]]
assert arrays['pxc_ask_loop'] == [sl[i] for i in (0, 1, 2, 3, 3) * 2], arrays['pxc_ask_loop']
assert arrays['pxc_step_ms'] == [46, 46, 43, 42], arrays['pxc_step_ms']
assert 'ht_pet_t pod_codex_pet = {"codex",44,56,NULL,pxc_loops,pxc_step_ms,&pxc_work,&pxc_listen,&pxc_send,pxc_frames,NULL,0,&pxc_relax,NULL}' in src

for k, v in arrays.items():
    if k.endswith('_pal'):
        assert len(v) <= 256, k
total = sum(len(v) for v in arrays.values())
# 1.32 M before the small pet's WORKING / DONE frames (nothing in main/ reads them) went: 1,165,112 now
assert total <= 1_170_000, total
steps = re.findall(r'\{(\d+),(\d+)\}', re.search(r'pxc_loops\[HT_PET_STATES\]\[HT_PET_STEPS\] = \{(.*?)\};\n', src).group(1))
rows = [steps[24 * i:24 * i + 24] for i in range(4)]
assert len(steps) == 96 and all(p == ('0', '0') for p in rows[1] + rows[2]) and len(set(rows[0])) > 1 < len(set(rows[3])), 'WORKING / DONE rows must be {0,0}'

# bars: inside the bubble (overlay frame 0 at ov_at[0]) at swing max, with the outline's margin
bars = re.search(r'pxc_listen_bars = \{\{(\d+),(\d+),(\d+)\},(\d+),(\d+),(\d+),(\d+),(\d+),', src)
bx, (cy, bw, rad, bmin, swing) = [int(bars[i]) for i in (1, 2, 3)], [int(bars[i]) for i in (4, 5, 6, 7, 8)]
ocols, orows = frames('pxc_listen_ov')[0][:2]
ax, ay = arrays['pxc_listen_ov_at'][0:2]
hmax = bmin + swing + 1
for x in bx:
    assert ax + 2 <= x and x + bw <= ax + ocols - 2, (x, bw, ax, ocols)
assert ay + 2 <= cy - hmax // 2 and cy + hmax // 2 + 1 <= ay + orows - 2, (cy, hmax, ay, orows)

# relax: while the plane is behind the robot (depth < 0) none of its ink lies on the robot's
spec = importlib.util.spec_from_file_location('gen', fw / 'scripts/gen_pro_codex.py')
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)
loop, oloop, at = arrays['pxc_relax_loop'], arrays['pxc_relax_ov_loop'], arrays['pxc_relax_ov_at']
behind = [n for n in range(gen.XTHROW + 1, gen.XCATCH) if gen.relax_loop_at((n - gen.XTHROW) / (gen.XCATCH - gen.XTHROW))[2] < 0]
assert len(behind) >= 5, behind
hit = 0
for n in behind:
    robot, plane = ink('pxc_relax', loop[n]), ink('pxc_relax_ov', oloop[n])
    ax, ay = at[2 * n], at[2 * n + 1]
    hit += len(plane)
    assert not any((x + ax, y + ay) in robot for x, y in plane), n
assert hit, 'no plane drawn behind the robot'
print(f'ok: {total} array elements, {len(behind)} behind-steps checked')
