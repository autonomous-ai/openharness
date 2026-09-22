#!/usr/bin/env python3
"""Convert the eight hands-on recordings into README GIFs, one per harness.

Run from the repository root:  python3 .github/assets/readme/build.py
Needs FFmpeg. Sources are the unedited recordings in docs/images/*-demo.mp4;
output goes to .github/assets/readme/beyond/<harness>.gif at full length and real speed.
"""
import os, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'beyond')
WIDTH = 800

GIFS = [  # harness, recording, frames per second
    ('blender', 'blender-shape-lab-demo.mp4', 8),
    ('circuitjs', 'scope-lab-demo.mp4', 8),
    ('mujoco', 'mujoco-what-if-demo.mp4', 8),
    ('godogen', 'godogen-rewind-demo.mp4', 8),
    ('strudel', 'strudel-live-take-demo.mp4', 6),   # busiest screen; fewer frames keep it light
    ('rdkit', 'rdkit-bond-scan-demo.mp4', 8),
    ('typst', 'doc-review-demo.mp4', 8),
    ('jev-sheets', 'question-lab-demo.mp4', 8),
]

os.makedirs(OUT, exist_ok=True)
for name, src, fps in GIFS:
    out = os.path.join(OUT, f'{name}.gif')
    vf = (f'fps={fps},scale={WIDTH}:-2:flags=lanczos,split[a][b];'
          f'[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle')
    # Skip the recording's first moments, where the page is still loading.
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '0.4', '-i', os.path.join(ROOT, 'docs/images', src),
                    '-filter_complex', vf, '-loop', '0', out], check=True)
    print(f'{name}.gif  {os.path.getsize(out) / 1048576:.1f} MiB')
