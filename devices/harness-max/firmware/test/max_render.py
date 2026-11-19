#!/usr/bin/env python3
"""Render Harness Max screens of the demo model (max_render.c) to PNGs, at 1920 x 480 and the demo bar's 1920 x 415.

    python3 test/max_render.py [--out DIR] [--height 480|415] [screen ...]     every screen, both heights, by default

Builds test/max_render.c as golden.sh does, with the Pro's fonts (PRO_FONT overrides the generator's default), and
converts each PPM with the Pro's pod_render.png. Writes <screen>.png (480) and <screen>-415.png to test/out/max unless
--out says otherwise.
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
    heights = [480, 415]
    if "--height" in args:
        i = args.index("--height")
        heights = [int(args[i + 1])]
        del args[i:i + 2]
    out.mkdir(parents=True, exist_ok=True)
    fonts = out / "pro_fonts.c"
    font = os.environ.get("PRO_FONT")
    subprocess.run([sys.executable, str(pro / "scripts" / "gen_fonts.py"), *(["--font", font] if font else []),
                    "--out", str(fonts)], check=True)
    disp, app, fork = pro / "main" / "display", fw / "main" / "app", fw / "main" / "pro_fork"
    for h in heights:
        exe = out / f"max_render-{h}"
        # As test/max_tree.sh: main/pro_fork/ first on the path, the glass force-included, the Max's compositor copies.
        subprocess.run(["cc", "-std=c11", "-D_DEFAULT_SOURCE", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
                        "-DHT_WIDTH=1920", f"-DHT_HEIGHT={h}", f"-I{fork}", "-include", str(fw / "main" / "max_glass.h"),
                        f"-I{app}", f"-I{pro / 'main'}", f"-I{disp}",
                        "-o", str(exe), str(here / "max_render.c"), *sorted(str(p) for p in app.glob("max_ui*.c")),
                        str(fork / "display" / "terminal.c"), str(fork / "display" / "pro_canvas.c"),
                        str(fork / "pod" / "pod_draw.c"),
                        *(str(pro / "main" / "pod" / f"{name}.c")
                          for name in ("pod_pet", "pets", "pets_ask", "pets_codex", "engine_logos")),
                        str(fonts)],
                       check=True)
        screens = args or subprocess.run([str(exe), "--list"], check=True, capture_output=True, text=True).stdout.split()
        for screen in screens:
            name = screen if h == 480 else f"{screen}-{h}"
            ppm, dest = out / f"{name}.ppm", out / f"{name}.png"
            subprocess.run([str(exe), screen, str(ppm)], check=True, stdout=subprocess.DEVNULL)
            png(ppm, dest)
            ppm.unlink()
            print(dest)
    return 0


if __name__ == "__main__":
    sys.exit(main())
