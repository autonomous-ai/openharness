#!/usr/bin/env python3
"""main/pod/pets_ask.c (scripts/gen_pro_ask.py): the "?" bubble and Claude's ask scene."""
import re
from pathlib import Path

fw = Path(__file__).resolve().parents[1]
src = (fw / 'main/pod/pets_ask.c').read_text()

for name, n in re.findall(r'static const uint16_t (\w+_pal)\[(\d+)\]', src):
    assert int(n) <= 256, name
b = re.search(r'ht_cell_frame_t pod_ask_bubble = \{(\d+),(\d+),1,', src)
assert b and (int(b[1]), int(b[2])) == (64, 74), b and b.groups()
m = re.search(r'ht_pet_scene_t pod_claude_ask = \{(\d+),(\d+),\w+,(\w+),(\d+),(\d+),NULL,', src)
assert m and (int(m[1]), int(m[2]), int(m[4]), int(m[5])) == (120, 102, 12, 120), m and m.groups()
loop = [int(v) for v in re.search(rf'{m[3]}\[\d+\] = \{{(.*?)\}};', src).group(1).split(',')]
up, down = loop[0], loop[7]
assert up != down and loop == [up] * 7 + [down] * 2 + [up] * 3, loop
print('test_pro_ask: ok')
