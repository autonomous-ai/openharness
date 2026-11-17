#!/usr/bin/env python3
"""Render Harness Max screens of the demo model (max_render.c) to 1920 x 480 PNGs.

    python3 test/max_render.py [--out DIR] [screen ...]     every screen when none is named

Builds test/max_render.c as golden.sh does, with the Pro's fonts (PRO_FONT overrides the generator's default), and
converts each PPM with the Pro's pod_render.png. Writes to test/out/max unless --out says otherwise.
"""
import os
import subprocess
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
fw = here.parent
pro = (fw / ".." / ".." / "harness-pro" / "firmware").resolve()
sys.path.insert(0, str(pro / "test"))
from pod_render import png  # noqa: E402  (the Pro's PPM to PNG)


def main() -> int:
    args = sys.argv[1:]
    out = here / "out" / "max"
    if "--out" in args:
        i = args.index("--out")
        out = Path(args[i + 1]).resolve()
        del args[i:i + 2]
    out.mkdir(parents=True, exist_ok=True)
    fonts = out / "pro_fonts.c"
    font = os.environ.get("PRO_FONT")
    subprocess.run([sys.executable, str(pro / "scripts" / "gen_fonts.py"), *(["--font", font] if font else []),
                    "--out", str(fonts)], check=True)
    exe = out / "max_render"
    disp, app = pro / "main" / "display", fw / "main" / "app"
    subprocess.run(["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
                    "-DHT_WIDTH=1920", "-DHT_HEIGHT=480", f"-I{app}", f"-I{pro / 'main'}", f"-I{disp}",
                    "-o", str(exe), str(here / "max_render.c"), *(str(app / f"max_ui_{p}.c") for p in ("model", "view", "touch")),
                    str(disp / "terminal.c"), str(disp / "pro_canvas.c"), str(pro / "main" / "pod" / "pod_draw.c"), str(fonts)],
                   check=True)
    screens = args or subprocess.run([str(exe), "--list"], check=True, capture_output=True, text=True).stdout.split()
    for screen in screens:
        ppm, dest = out / f"{screen}.ppm", out / f"{screen}.png"
        subprocess.run([str(exe), screen, str(ppm)], check=True, stdout=subprocess.DEVNULL)
        png(ppm, dest)
        ppm.unlink()
        print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
