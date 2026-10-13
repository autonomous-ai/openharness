#!/usr/bin/env python3
"""Render Pod screens of the demo model to PNG under test/out/pod/.

    python3 test/pod_render.py tabs tab:1 recent agent:fw recap:desk talk:fw [--now MS]

Builds test/pod_render.c with the flags run-pod.sh uses, runs it once per screen and converts each PPM to PNG
(zlib only, no imaging library). Generates the Pro fonts into test/out/pod with scripts/gen_fonts.py (PRO_FONT
overrides its default font), like run.sh.
"""
import os
import struct
import subprocess
import sys
import zlib
from pathlib import Path

here = Path(__file__).resolve().parent
fw = here.parent
disp = fw / "main" / "display"
out = here / "out" / "pod"


def png(ppm: Path, dest: Path) -> None:
    data = ppm.read_bytes()
    # P6\n720 720\n255\n
    parts = data.split(b"\n", 3)
    w, h = (int(v) for v in parts[1].split())
    pixels = parts[3]
    raw = b"".join(b"\x00" + pixels[y * w * 3:(y + 1) * w * 3] for y in range(h))

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    dest.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def main() -> int:
    args = sys.argv[1:]
    now = []
    if "--now" in args:
        i = args.index("--now")
        now = [args[i + 1]]
        del args[i:i + 2]
    if not args:
        print(__doc__)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    fonts = out / "pro_fonts.c"
    font = os.environ.get("PRO_FONT")
    subprocess.run([sys.executable, str(fw / "scripts" / "gen_fonts.py"), *(["--font", font] if font else []),
                    "--out", str(fonts)], check=True)
    exe = out / "pod_render"
    cmd = ["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
           "-DHT_FACE_PX=720",
           f"-I{disp}", f"-I{fw / 'main'}", f"-I{here / 'host_stubs'}",
           "-o", str(exe), str(here / "pod_render.c"), *sorted(str(p) for p in (fw / "main" / "pod").glob("*.c")),
           str(disp / "pro_canvas.c"), str(disp / "terminal.c"), str(fonts)]
    subprocess.run(cmd, check=True)
    for screen in args:
        name = screen.replace(":", "-")
        ppm, dest = out / f"{name}.ppm", out / f"{name}.png"
        subprocess.run([str(exe), screen, str(ppm), *now], check=True)
        png(ppm, dest)
        ppm.unlink()
        print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
