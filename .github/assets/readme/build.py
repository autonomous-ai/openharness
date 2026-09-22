#!/usr/bin/env python3
"""Build the two README animations.

  coding-tour.gif   the coding workspace, one feature per slide
  beyond-code.gif   eight recorded hands-on sessions, one per slide

Run from the repository root:  python3 .github/assets/readme/build.py
Needs Python 3 with Pillow and NumPy, FFmpeg, and macOS system fonts (SF Pro, SF Mono).
The coding video is downloaded from the CDN; hands-on recordings come from docs/images/.
"""
import os, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
OUT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get('README_ASSET_CACHE', os.path.join(OUT, '.cache'))
CODING_URL = 'https://cdn.autonomous.ai/development/ecm/260910/Thumb-harness-app.mp4'

W, H, BAND = 1280, 800, 80          # canvas; the caption band sits on top
CW, CH = W, H - BAND                # content area, 16:9
BG = (13, 17, 23)
FG = (240, 246, 252)
DIM = (139, 148, 158)
LINE = (48, 54, 61)

SF = '/System/Library/Fonts/SFNS.ttf'
MONO = '/System/Library/Fonts/SFNSMono.ttf'

def font(path, size, weight='Regular'):
    f = ImageFont.truetype(path, size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

TITLE = font(SF, 34, 'Bold')
TAG = font(MONO, 20, 'Regular')
COUNT = font(MONO, 18, 'Medium')

# ---------------------------------------------------------------- video input

def frames_from(path, start, dur, fps, crop=None, speed=1.0):
    """Yield content frames (CW x CH) from a video clip, blur-filled to 16:9."""
    pre = f'crop={crop},' if crop else ''
    vf = (f'{pre}setpts=PTS/{speed},fps={fps},split[a][b];'
          f'[a]scale={CW}:{CH}:force_original_aspect_ratio=increase,crop={CW}:{CH},boxblur=40:2,eq=brightness=-0.28:saturation=0.8[bg];'
          f'[b]scale={CW}:{CH}:force_original_aspect_ratio=decrease:flags=lanczos[fg];'
          f'[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24')
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur * speed), '-i', path,
           '-filter_complex', vf, '-f', 'rawvideo', '-']
    raw = subprocess.run(cmd, check=True, capture_output=True).stdout
    n = len(raw) // (CW * CH * 3)
    for i in range(n):
        yield Image.frombuffer('RGB', (CW, CH), raw[i * CW * CH * 3:(i + 1) * CW * CH * 3])

# ---------------------------------------------------------------- caption band

def band(title, tag, accent, index, total, progress):
    img = Image.new('RGB', (W, BAND), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 5, BAND], fill=accent)
    d.text((36, BAND // 2), title, font=TITLE, fill=FG, anchor='lm')
    tx = 36 + d.textlength(title, font=TITLE) + 22
    d.text((tx, BAND // 2 + 2), tag, font=TAG, fill=DIM, anchor='lm')
    # slide dots on the right
    r, gap = 5, 20
    x0 = W - 36 - (total - 1) * gap
    for i in range(total):
        cx = x0 + i * gap
        if i == index:
            d.ellipse([cx - r, BAND // 2 - r, cx + r, BAND // 2 + r], fill=accent)
        else:
            d.ellipse([cx - 3, BAND // 2 - 3, cx + 3, BAND // 2 + 3], fill=LINE)
    # progress rule along the bottom of the band
    d.rectangle([0, BAND - 2, W, BAND], fill=(22, 27, 34))
    d.rectangle([0, BAND - 2, int(W * progress), BAND], fill=accent)
    return img

def compose(slides, fps, out_gif, colors=256, width=W):
    frames = []
    for i, s in enumerate(slides):
        content = list(s['frames']())
        for k, c in enumerate(content):
            canvas = Image.new('RGB', (W, H), BG)
            canvas.paste(band(s['title'], s['tag'], s['accent'], i, len(slides), (k + 1) / len(content)), (0, 0))
            canvas.paste(c, (0, BAND))
            frames.append(canvas)
        print(f'  {s["title"]}: {len(content)} frames', file=sys.stderr)
    raw = b''.join(f.tobytes() for f in frames)
    vf = (f'scale={width}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors={colors}:stats_mode=diff[p];'
          f'[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                    '-r', str(fps), '-i', '-', '-filter_complex', vf, '-loop', '0', out_gif],
                   input=raw, check=True)
    print(f'{os.path.relpath(out_gif, ROOT)}: {len(frames)} frames, {len(frames)/fps:.1f} s, '
          f'{os.path.getsize(out_gif)/1048576:.2f} MiB', file=sys.stderr)

# ---------------------------------------------------------------- rendered slides

APP_BG = (17, 17, 17)

def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)

def keycap(d, x, y, label, lit, accent, f):
    w = max(46, int(d.textlength(label, font=f)) + 26)
    fill = accent if lit else (31, 35, 40)
    edge = accent if lit else (58, 64, 72)
    d.rounded_rectangle([x, y + 3, x + w, y + 47], 9, fill=(10, 12, 15))
    d.rounded_rectangle([x, y, x + w, y + 44], 9, fill=fill, outline=edge, width=2)
    d.text((x + w / 2, y + 22), label, font=f, fill=(15, 15, 15) if lit else FG, anchor='mm')
    return w

KEYS = [
    (['⌘N'], 'New harness', 'type the task, press Return'),
    (['⌘O'], 'Open anything', 'by name, project, machine or output'),
    (['⌘R', '⌘D'], 'Split right, split down', 'any agent, any machine'),
    (['⌘H', '⌘J', '⌘K', '⌘L'], 'Move between panes', 'vim keys'),
    (['⌘⏎'], 'Zoom the pane', 'and back'),
    (['⇧⌘I'], 'Agents needing input', 'jump to the one waiting on you'),
    (['⌘P'], 'Every command', 'one search, remap any key'),
]

def keyboard_frames(fps, accent, step=0.62, hold=1.0):
    kf = font(SF, 22, 'Semibold')
    act = font(SF, 25, 'Semibold')
    det = font(SF, 19, 'Regular')
    n = int((len(KEYS) * step + hold) * fps)
    row_h, top = 76, (CH - len(KEYS) * 76) // 2
    left = 190
    for i in range(n):
        t = i / fps
        cur = min(len(KEYS) - 1, int(t / step))
        img = Image.new('RGB', (CW, CH), APP_BG)
        d = ImageDraw.Draw(img)
        for r, (keys, action, detail) in enumerate(KEYS):
            y = top + r * row_h
            lit = r == cur
            if lit:
                d.rounded_rectangle([left - 30, y - 8, CW - left + 30, y + 60], 12, fill=(28, 33, 41))
                d.rectangle([left - 30, y - 8, left - 25, y + 60], fill=accent)
            x = left
            for k in keys:
                x += keycap(d, x, y, k, lit, accent, kf) + 10
            ax = left + 300
            d.text((ax, y + 22), action, font=act, fill=FG if lit else (170, 177, 186), anchor='lm')
            d.text((ax + d.textlength(action, font=act) + 18, y + 23), detail, font=det,
                   fill=DIM if lit else (95, 102, 110), anchor='lm')
        yield img

def lock(d, cx, cy, s, color):
    d.rounded_rectangle([cx - s, cy - s * 0.2, cx + s, cy + s], int(s * 0.3), fill=color)
    d.arc([cx - s * 0.62, cy - s * 1.15, cx + s * 0.62, cy + s * 0.1], 180, 360, fill=color, width=max(2, int(s * 0.28)))

def node(d, x, y, w, h, name, sub, accent, f1, f2, glow=0.0):
    if glow > 0:
        c = tuple(int(LINE[j] + (accent[j] - LINE[j]) * glow) for j in range(3))
    else:
        c = LINE
    d.rounded_rectangle([x, y, x + w, y + h], 14, fill=(22, 27, 34), outline=c, width=3)
    d.text((x + 22, y + 30), name, font=f1, fill=FG, anchor='lm')
    d.text((x + 22, y + 62), sub, font=f2, fill=DIM, anchor='lm')

CIPHER = ['9f3a c17e 04b2 e8d1', '5c07 a9fe 31d8 b246', 'e41b 7d20 9ac3 5f18']

def e2ee_frames(fps, accent, dur=6.0):
    f1 = font(MONO, 24, 'Semibold'); f2 = font(SF, 18); f3 = font(MONO, 17, 'Medium')
    f4 = font(SF, 20, 'Semibold'); f5 = font(MONO, 16)
    you = (80, 290, 300, 92)
    relay = (490, 310, 300, 52)
    srv = [(900, 170, 300, 92), (900, 430, 300, 92)]
    names = [('macbook-pro', 'you, at home'), ('home-server', 'Claude Code · eval-sweep'),
             ('lambda-h100', 'Codex · finetune')]
    packets = [  # (start, to server index, plaintext)
        (0.3, 0, 'run the eval sweep'),
        (2.1, 1, 'resume the finetune'),
        (3.9, 0, 'ship it'),
    ]
    travel = 1.5
    n = int(dur * fps)
    for i in range(n):
        t = i / fps
        img = Image.new('RGB', (CW, CH), APP_BG)
        d = ImageDraw.Draw(img)
        yc = you[1] + you[3] // 2
        ya = (you[0] + you[2], yc); rl = (relay[0], relay[1] + relay[3] // 2); rr = (relay[0] + relay[2], relay[1] + relay[3] // 2)
        ends = [(s[0], s[1] + s[3] // 2) for s in srv]
        # links through the relay
        d.line([ya, rl], fill=LINE, width=3)
        for e in ends: d.line([rr, e], fill=LINE, width=3)
        # direct path (WebRTC) drawn dashed under the relay
        for e in ends:
            steps = 40
            for k in range(0, steps, 2):
                p0 = ya[0] + (e[0] - ya[0]) * k / steps, ya[1] + (e[1] - ya[1]) * k / steps
                p1 = ya[0] + (e[0] - ya[0]) * (k + 1) / steps, ya[1] + (e[1] - ya[1]) * (k + 1) / steps
                d.line([p0, p1], fill=(40, 46, 54), width=2)
        # relay
        d.rounded_rectangle([relay[0], relay[1], relay[0] + relay[2], relay[1] + relay[3]], 14,
                            fill=(22, 27, 34), outline=LINE, width=3)
        d.text((relay[0] + relay[2] / 2, relay[1] - 50), 'relay', font=f1, fill=FG, anchor='mm')
        d.text((relay[0] + relay[2] / 2, relay[1] - 20), 'no keys · sees ciphertext only', font=f2, fill=DIM, anchor='mm')
        d.text((CW / 2, 600), 'direct peer-to-peer when the network allows',
               font=f2, fill=(110, 118, 128), anchor='mm')
        # nodes, glowing when a message lands
        glow_you = 0.0; glows = [0.0, 0.0]
        for (st, j, _) in packets:
            if st - 0.1 <= t <= st + 0.35: glow_you = 1 - abs(t - st - 0.1) / 0.35
            if st + travel <= t <= st + travel + 0.6: glows[j] = max(glows[j], 1 - (t - st - travel) / 0.6)
        node(d, *you, *names[0], accent, f1, f2, glow_you)
        for k, s in enumerate(srv): node(d, *s, *names[k + 1], accent, f1, f2, glows[k])
        # packets
        for (st, j, text) in packets:
            p = (t - st) / travel
            if 0 <= p <= 1:
                q = ease(p)
                a, b, c = ya, (relay[0] + relay[2] / 2, rl[1]), ends[j]
                if q < 0.5:
                    u = q / 0.5; x = a[0] + (b[0] - a[0]) * u; y = a[1] + (b[1] - a[1]) * u
                else:
                    u = (q - 0.5) / 0.5; x = b[0] + (c[0] - b[0]) * u; y = b[1] + (c[1] - b[1]) * u
                label = CIPHER[packets.index((st, j, text))]
                tw = d.textlength(label, font=f3) + 50
                d.rounded_rectangle([x - tw / 2, y - 19, x + tw / 2, y + 19], 19, fill=(38, 44, 52), outline=accent, width=2)
                lock(d, x - tw / 2 + 20, y - 1, 7, accent)
                d.text((x + 12, y), label, font=f3, fill=(200, 208, 216), anchor='mm')
            # plaintext at the two ends
            if st - 0.2 <= t <= st + 0.5:
                d.text((you[0] + 22, you[1] + you[3] + 28), f'> {text}', font=f3, fill=accent, anchor='lm')
            if st + travel <= t <= st + travel + 1.2:
                s = srv[j]
                d.text((s[0] + 22, s[1] + s[3] + 28), f'> {text}', font=f3, fill=accent, anchor='lm')
        # the crypto, stated plainly
        d.text((CW / 2, 650), 'X25519 · ChaCha20-Poly1305 · Ed25519 pinned keys · always on, no switch',
               font=f5, fill=(110, 118, 128), anchor='mm')
        yield img

# ---------------------------------------------------------------- slide lists

def coding_video():
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, 'harness-coding-demo.mp4')
    if not os.path.exists(path):
        subprocess.run(['curl', '-fsSL', '-o', path, CODING_URL], check=True)
    return path

WINDOW = '1680:945:119:65'      # the app window inside the 1920 x 1080 recording
ZOOM = '1120:630:119:65'        # sidebar and left panes, for the machines slide

def coding_tour():
    v = coding_video(); fps = 12
    slides = [
        dict(title='Every coding agent', tag='Claude Code · Codex · Cursor · OpenCode · +10 more', accent=(217, 119, 87),
             frames=lambda: frames_from(v, 0.0, 3.4, fps, WINDOW, speed=0.7)),
        dict(title='Every machine', tag='laptop · home server · office · GPU box', accent=(126, 231, 135),
             frames=lambda: frames_from(v, 2.3, 8.3, fps, ZOOM)),
        dict(title='Keyboard first', tag='every action has a key', accent=(210, 168, 255),
             frames=lambda: keyboard_frames(fps, (210, 168, 255))),
        dict(title='End-to-end encrypted', tag='no SSH · no VPN · no open ports', accent=(88, 166, 255),
             frames=lambda: e2ee_frames(fps, (88, 166, 255))),
    ]
    compose(slides, fps, os.path.join(OUT, 'coding-tour.gif'))

HANDS_ON = [  # recording, start, seconds, title, harness, accent
    ('blender-shape-lab-demo.mp4', 8.4, 4.4, 'Shape a lamp', 'Blender · 3D design', (232, 125, 62)),
    ('mujoco-what-if-demo.mp4', 1.4, 3.8, 'Shove a robot', 'MuJoCo · physics', (63, 207, 170)),
    ('godogen-rewind-demo.mp4', 0.0, 3.8, 'Rewind a jump', 'Godogen · games', (46, 160, 120)),
    ('scope-lab-demo.mp4', 6.4, 4.2, 'Compare a signal', 'CircuitJS · circuits', (126, 231, 135)),
    ('rdkit-bond-scan-demo.mp4', 3.0, 4.2, 'Turn a molecule', 'RDKit · chemistry', (248, 81, 73)),
    ('strudel-live-take-demo.mp4', 2.0, 3.8, 'Perform a track', 'Strudel · music', (163, 113, 247)),
    ('doc-review-demo.mp4', 2.8, 4.2, 'Review a draft', 'Typst · documents', (88, 166, 255)),
    ('question-lab-demo.mp4', 1.0, 3.8, 'Ask a better question', 'Jev Sheets · data', (227, 179, 65)),
]

def beyond_code():
    fps = 8
    slides = []
    for (f, st, dur, title, tag, acc) in HANDS_ON:
        p = os.path.join(ROOT, 'docs', 'images', f)
        slides.append(dict(title=title, tag=tag, accent=acc,
                           frames=(lambda p=p, st=st, dur=dur: frames_from(p, st, dur, fps))))
    compose(slides, fps, os.path.join(OUT, 'beyond-code.gif'), width=1120)

if __name__ == '__main__':
    which = sys.argv[1:] or ['coding', 'beyond']
    if 'coding' in which: coding_tour()
    if 'beyond' in which: beyond_code()
