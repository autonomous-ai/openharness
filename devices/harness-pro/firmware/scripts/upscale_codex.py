#!/usr/bin/env python3
"""Codex HD frames: python3 scripts/upscale_codex.py --esrgan BIN [--models DIR] [--src DIR] [--out DIR]

Build-time only (the HD PNGs are committed). Real-ESRGAN x4 (realesrgan-x4plus-anime) on every source frame, then
premultiplied Lanczos:
  scene loops (running listening waving idle): round(192*K) x round(208*K) -> out/scene/<loop>/NN.png
  small loops (idle review waiting): union alpha box of the x4 frames, height 224 -> out/small/<loop>/NN.png
K (the room's 1.6) is written to out/K.txt; gen_pro_codex.py reads it back.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

K = 1.6
SCENE = ("running", "listening", "waving", "idle")
SMALL = ("idle", "review", "waiting")
SMALL_H = 224
here = Path(__file__).resolve().parent.parent


def lanczos(im, size):
    """Premultiplied Lanczos: transparent pixels' colour does not bleed into the edge."""
    r, g, b, a = im.convert("RGBA").split()
    pm = Image.merge("RGBA", [Image.composite(c, Image.new("L", im.size, 0), a) for c in (r, g, b)] + [a])
    pm = pm.resize(size, Image.LANCZOS)
    px = pm.load()
    for y in range(size[1]):
        for x in range(size[0]):
            r, g, b, a = px[x, y]
            if a:
                px[x, y] = (min(255, r * 255 // a), min(255, g * 255 // a), min(255, b * 255 // a), a)
    return pm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--esrgan", required=True)
    ap.add_argument("--models")
    ap.add_argument("--src", type=Path, default=here / "assets/codex/src")
    ap.add_argument("--out", type=Path, default=here / "assets/codex/hd")
    a = ap.parse_args()
    models = a.models or str(Path(a.esrgan).parent / "models")
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "K.txt").write_text(f"{K}\n")
    k = float((a.out / "K.txt").read_text())
    size = (round(192 * k), round(208 * k))
    x4 = {}
    with tempfile.TemporaryDirectory() as tmp:
        for loop in sorted(set(SCENE + SMALL)):
            for f in sorted((a.src / loop).glob("*.png")):
                o = Path(tmp) / f"{loop}-{f.name}"
                r = subprocess.run([a.esrgan, "-i", str(f), "-o", str(o), "-n", "realesrgan-x4plus-anime", "-s", "4", "-m", models],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
                if r.returncode:
                    sys.exit(f"{a.esrgan} failed on {f} (exit {r.returncode}):\n{r.stderr}")
                x4[loop, f.name] = Image.open(o).convert("RGBA")
    n = 0
    for loop in SCENE:
        (a.out / "scene" / loop).mkdir(parents=True, exist_ok=True)
        for (l, name), im in x4.items():
            if l == loop:
                lanczos(im, size).save(a.out / "scene" / loop / name, optimize=True); n += 1
    # The small loops' union box from the 1x source alpha, x4: the upscaler's faint haze would widen a box taken from its output.
    u = None
    for loop in SMALL:
        for f in sorted((a.src / loop).glob("*.png")):
            bb = Image.open(f).getchannel("A").getbbox()
            u = bb if u is None else (min(u[0], bb[0]), min(u[1], bb[1]), max(u[2], bb[2]), max(u[3], bb[3]))
    u = tuple(v * 4 for v in u)
    w = round((u[2] - u[0]) * SMALL_H / (u[3] - u[1]))
    m = 0
    for loop in SMALL:
        (a.out / "small" / loop).mkdir(parents=True, exist_ok=True)
        for (l, name), im in x4.items():
            if l == loop:
                lanczos(im.crop(u), (w, SMALL_H)).save(a.out / "small" / loop / name, optimize=True); m += 1
    print(f"K={k} scene {size[0]}x{size[1]} x{n}, small {w}x{SMALL_H} x{m}, union box {u}")


if __name__ == "__main__":
    main()
