#!/usr/bin/env python3
"""Codex on-screen size guard: python3 test/codex_size.py [--record]

Renders the Pets screens that show a Codex pet (test/pod_render.py), measures the pet's ink box in a fixed region around
it and compares it with test/codex_size_baseline.txt (each side within 3%). --record writes the baseline.
Ink = a pixel with b > r + 20 that differs by more than 40 (L1) from the region's left-edge pixel of its row: the region
holds only the pet (and its overlays), the row reference removes the Tabs card's blue gradient. Relax is the Recap
screen (recap:docs): the Pets UI plays RELAX only there, at zoom 8. Rest is agent:be:offline.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

here = Path(__file__).resolve().parent
base = here / "codex_size_baseline.txt"
TOL = 0.03
# label: (screen, region x0 y0 x1 y1 in the 720 x 720 render)
REGIONS = {
    "agent:be": ("agent:be", (150, 260, 610, 580)),                 # working, 13/8 smooth today
    # asking: the Codex waving scene at 1x (pod_codex_ask, the asking look), no longer the small pet. It is taller, so the region starts higher
    # (380, under the question's tail) and this row's baseline was re-recorded by design; the "?" bubble is cream, not blue: never measured.
    "agent:cli": ("agent:cli", (40, 380, 360, 680)),
    "agent:be:offline": ("agent:be:offline", (150, 260, 610, 580)),  # rest room
    "recap:docs": ("recap:docs", (0, 415, 260, 560)),               # relax + recap
    "talk:be": ("talk:be", (150, 200, 600, 560)),
    "talk:be:send": ("talk:be:send", (150, 200, 600, 560)),
    "inbox#a": ("inbox", (60, 120, 200, 230)),                      # harness-cli's avatar
    "inbox#b": ("inbox", (60, 290, 200, 410)),                      # backend's avatar
}


def box(im, r):
    x0, y0, x1, y1 = r
    px = im.load()
    xs, ys = [], []
    for y in range(y0, y1):
        rr, rg, rb = px[x0, y]
        for x in range(x0 + 1, x1):
            p = px[x, y]
            if p[2] > p[0] + 20 and abs(p[0] - rr) + abs(p[1] - rg) + abs(p[2] - rb) > 40:
                xs.append(x); ys.append(y)
    return (min(xs), min(ys), max(xs) + 1, max(ys) + 1) if xs else (0, 0, 0, 0)


def main() -> int:
    screens = sorted({s for s, _ in REGIONS.values()})
    subprocess.run([sys.executable, str(here / "pod_render.py"), *screens], check=True, stdout=subprocess.DEVNULL)
    got = {}
    for label, (screen, r) in REGIONS.items():
        im = Image.open(here / "out" / "pod" / (screen.replace(":", "-") + ".png")).convert("RGB")
        got[label] = box(im, r)
    if "--record" in sys.argv:
        base.write_text("".join(f"{k} {' '.join(map(str, v))}\n" for k, v in got.items()))
        print(base.read_text(), end="")
        return 0
    want = {l.split()[0]: tuple(map(int, l.split()[1:])) for l in base.read_text().splitlines() if l.strip()}
    bad = 0
    for k, v in got.items():
        w = want[k]
        tol = (TOL * max(w[2] - w[0], 1), TOL * max(w[3] - w[1], 1))   # 3% of the baseline box's width / height
        ok = all(abs(a - b) <= tol[i % 2] for i, (a, b) in enumerate(zip(v, w)))
        print(f"{'ok ' if ok else 'BAD'} {k} now {v} was {w}")
        bad += not ok
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
