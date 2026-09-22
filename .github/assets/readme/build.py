#!/usr/bin/env python3
"""Build beyond-code.gif: eight recorded hands-on sessions, cross-faded into one loop.

Run from the repository root:  python3 .github/assets/readme/build.py
Needs Python 3 with Pillow, FFmpeg, and the macOS system font SF Pro.
Recordings come from docs/images/*-demo.mp4 and harness icons from desktop/assets/engine-icons/.
"""
import os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'beyond-code.gif')
W, H, FPS, FADE = 1280, 800, 8, 3          # FADE is in frames
OUT_W = 980                                # keeps the GIF under 9 MiB

SF = '/System/Library/Fonts/SFNS.ttf'
def font(size, weight):
    f = ImageFont.truetype(SF, size)
    f.set_variation_by_name(weight)
    return f
NAME, WHAT = font(24, 'Bold'), font(24, 'Regular')

CLIPS = [  # recording, start, seconds, harness id, harness name, what the session does
    ('blender-shape-lab-demo.mp4', 8.4, 3.3, 'blender', 'Blender', 'shape a lamp'),
    ('mujoco-what-if-demo.mp4', 1.4, 3.3, 'mujoco', 'MuJoCo', 'shove a robot, compare two futures'),
    ('godogen-rewind-demo.mp4', 0.0, 3.3, 'godogen', 'Godogen', 'play a game you just made'),
    ('scope-lab-demo.mp4', 6.4, 3.3, 'circuitjs', 'CircuitJS', 'probe a filter circuit'),
    ('rdkit-bond-scan-demo.mp4', 3.0, 3.3, 'rdkit', 'RDKit', 'turn a molecule'),
    ('strudel-live-take-demo.mp4', 2.0, 3.3, 'strudel', 'Strudel', 'perform a track'),
    ('doc-review-demo.mp4', 2.8, 3.3, 'typst', 'Typst', 'review a draft'),
    ('question-lab-demo.mp4', 1.0, 3.3, 'jev-sheets', 'Jev Sheets', 'ask your data a better question'),
]

def frames(path, start, dur):
    vf = (f'fps={FPS},split[a][b];'
          f'[a]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},boxblur=40:2,eq=brightness=-0.3:saturation=0.8[bg];'
          f'[b]scale={W}:{H}:force_original_aspect_ratio=decrease:flags=lanczos[fg];'
          f'[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24')
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', path,
                          '-filter_complex', vf, '-f', 'rawvideo', '-'], check=True, capture_output=True).stdout
    size = W * H * 3
    return [Image.frombuffer('RGB', (W, H), raw[i * size:(i + 1) * size]) for i in range(len(raw) // size)]

def label(icon_id, name, what):
    """A pill in the lower left: harness icon, harness name, what the session does."""
    icon = Image.open(os.path.join(ROOT, 'desktop/assets/engine-icons', f'{icon_id}.png')).convert('RGBA').resize((34, 34), Image.LANCZOS)
    probe = ImageDraw.Draw(Image.new('RGB', (1, 1)))
    w = 22 + 34 + 14 + probe.textlength(name, font=NAME) + 12 + probe.textlength(what, font=WHAT) + 26
    pill = Image.new('RGBA', (int(w), 60), (0, 0, 0, 0))
    d = ImageDraw.Draw(pill)
    d.rounded_rectangle([0, 0, w - 1, 59], 30, fill=(14, 16, 20, 232), outline=(64, 68, 76, 255), width=2)
    mask = Image.new('L', (34, 34), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, 33, 33], 8, fill=255)
    pill.paste(icon, (22, 13), mask)
    x = 22 + 34 + 14
    d.text((x, 30), name, font=NAME, fill=(255, 255, 255), anchor='lm')
    x += probe.textlength(name, font=NAME) + 12
    d.text((x, 30), what, font=WHAT, fill=(170, 177, 186), anchor='lm')
    return pill

clips = []
for (f, st, dur, icon, name, what) in CLIPS:
    fr = frames(os.path.join(ROOT, 'docs/images', f), st, dur)
    clips.append((fr, label(icon, name, what)))
    print(f'  {name}: {len(fr)} frames', file=sys.stderr)

# Each clip dissolves into the next; the last dissolves into the first so the loop is seamless.
# The label of the incoming clip stays sharp through the dissolve.
# The loop opens on a clean first frame; the dissolve back into it closes the loop.
out = []
for i, (fr, tag) in enumerate(clips):
    seq = [im.copy() for im in fr[:len(fr) - FADE]]
    nxt, ntag = clips[(i + 1) % len(clips)]
    fade = [Image.blend(fr[len(fr) - FADE + j], nxt[0], (j + 1) / (FADE + 1)) for j in range(FADE)]
    for im in seq:
        im.paste(tag, (28, H - 28 - tag.height), tag)
    for im in fade:
        im.paste(ntag, (28, H - 28 - ntag.height), ntag)
    out.extend(seq + fade)
    clips[(i + 1) % len(clips)] = (nxt[1:] if i + 1 < len(clips) else nxt, ntag)

vf = (f'scale={OUT_W}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];'
      f'[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(FPS),
                '-i', '-', '-filter_complex', vf, '-loop', '0', OUT], input=b''.join(im.tobytes() for im in out), check=True)
print(f'beyond-code.gif: {len(out)} frames, {len(out) / FPS:.1f} s, {os.path.getsize(OUT) / 1048576:.2f} MiB', file=sys.stderr)
