#!/usr/bin/env python3
"""The ten init daemons, drawn as registered, antialiased bitmap layers.

These are illustrations, not a renderer for the ASCII plates. Species identity
comes from ``daemons/roster.json`` and ``daemons/plates/<id>.mjs``. Tim retains
the approved Pro octopus geometry; Tux is the midnight / pink bow-tie 1363
individual. The remaining eight are drawn in that same soft, restrained style.

The device never runs this module or evaluates vector geometry. The packer
rasterizes these four layers on the host, crops each transparent extent, and
encodes RGB565 plus alpha. Rear and front layers are appendage poses. Body is
bit-for-bit invariant. Face is independently registered to that body, so shared
firmware can compose expressions, touch gaze, and speech without storing whole
animation frames. Nothing in this module decides application state or timing.

Layer order: rear, body, front, face. Coordinates: 350 x 350; y=315 is the
common floor. Transparent outer pixels are deliberately cleared after AA.
"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


SIZE = 350
SCALE = 3
IDS = ("tim", "gnu", "lynx", "mutt", "yak", "gopher", "bug", "tux", "auk", "beastie")
MOODS = ("idle", "working", "attention", "done", "offline", "asleep", "booped", "listening")
EXPRESSIONS = ("idle", "blink", "working", "attention", "done", "offline", "asleep", "booped", "listening")
EMOTIONS = ("warm", "happy", "excited", "gentle", "sad", "thoughtful", "curious", "angry")
DISPLAY_NAMES = {"tim": "Tim", "gnu": "GNU", "lynx": "Lynx", "mutt": "Mutt", "yak": "Yak",
                 "gopher": "Gopher", "bug": "Bug", "tux": "Tux", "auk": "Auk", "beastie": "Beastie"}
DEFAULT_SCENES = {"tim": "meadow", "gnu": "meadow", "lynx": "paper", "mutt": "meadow",
                  "yak": "paper", "gopher": "meadow", "bug": "dusk", "tux": "shore",
                  "auk": "shore", "beastie": "dusk"}
LETTER_ANCHORS = {"tim": (226, 220), "gnu": (217, 245), "lynx": (217, 235),
                  "mutt": (225, 237), "yak": (235, 239), "gopher": (216, 239),
                  "bug": (199, 240), "tux": (218, 235), "auk": (227, 240),
                  "beastie": (93, 231)}

# These are local art coordinates, useful to previews and future accessories.
# Eye tuples are centre x/y and horizontal/vertical radius. Auk is in profile.
FACE_ANCHORS = {
    "tim": {"eyes": ((125, 142, 22, 25), (215, 142, 22, 25)), "mouth": (170, 180)},
    "gnu": {"eyes": ((142, 161, 16, 19), (208, 161, 16, 19)), "mouth": (175, 236)},
    "lynx": {"eyes": ((133, 157, 19, 22), (213, 157, 19, 22)), "mouth": (173, 202)},
    "mutt": {"eyes": ((144, 154, 18, 21), (210, 154, 18, 21)), "mouth": (178, 213)},
    "yak": {"eyes": ((137, 165, 17, 21), (213, 165, 17, 21)), "mouth": (175, 233)},
    "gopher": {"eyes": ((137, 154, 19, 22), (213, 154, 19, 22)), "mouth": (175, 211)},
    "bug": {"eyes": ((151, 165, 16, 20), (199, 165, 16, 20)), "mouth": (175, 201)},
    "tux": {"eyes": ((144, 145, 19, 23), (206, 145, 19, 23)), "mouth": (175, 184)},
    "auk": {"eyes": ((166, 135, 20, 24),), "mouth": (111, 168)},
    "beastie": {"eyes": ((141, 151, 18, 22), (207, 151, 18, 22)), "mouth": (174, 193)},
}

INK = "#353140"
CREAM = "#fbf3df"


def cubic(a, b, c, d, steps=48):
    """A sampled cubic with predictable, short paths (host-side only)."""
    points = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        points.append((u*u*u*a[0] + 3*u*u*t*b[0] + 3*u*t*t*c[0] + t*t*t*d[0],
                       u*u*u*a[1] + 3*u*u*t*b[1] + 3*u*t*t*c[1] + t*t*t*d[1]))
    return points


class Canvas:
    def __init__(self):
        self.image = Image.new("RGBA", (SIZE * SCALE, SIZE * SCALE))
        self.draw = ImageDraw.Draw(self.image)

    @staticmethod
    def point(p):
        return tuple(round(x * SCALE) for x in p)

    @staticmethod
    def box(b):
        return tuple(round(x * SCALE) for x in b)

    def ellipse(self, b, fill, outline=None, width=1):
        self.draw.ellipse(self.box(b), fill, outline, round(width * SCALE))

    def circle(self, x, y, r, fill, outline=None, width=1):
        self.ellipse((x-r, y-r, x+r, y+r), fill, outline, width)

    def roundrect(self, b, radius, fill, outline=None, width=1):
        self.draw.rounded_rectangle(self.box(b), round(radius * SCALE), fill, outline, round(width * SCALE))

    def polygon(self, points, fill):
        self.draw.polygon([self.point(p) for p in points], fill)

    def line(self, points, fill, width=1, rounded=True):
        self.draw.line([self.point(p) for p in points], fill, max(1, round(width * SCALE)), joint="curve")
        if rounded:
            for x, y in (points[0], points[-1]):
                self.circle(x, y, width/2, fill)

    def curve(self, a, b, c, d, fill, width=1):
        self.line(cubic(a, b, c, d), fill, width)

    def arc(self, b, start, end, fill, width=1):
        self.draw.arc(self.box(b), start, end, fill, max(1, round(width * SCALE)))

    def shape(self, start, segments, fill):
        """A closed, filled sequence of cubics; far less texture than a mesh."""
        points = [start]
        a = start
        for b, c, d in segments:
            points.extend(cubic(a, b, c, d)[1:])
            a = d
        self.polygon(points, fill)

    def tube(self, points, fill, start_width, end_width=None):
        end_width = start_width if end_width is None else end_width
        # A filled taper is useful for horns/ears, whose silhouette must survive
        # at compact size. The host pays for the sampled disks just once.
        for i, (x, y) in enumerate(points):
            t = i / max(1, len(points)-1)
            self.circle(x, y, (start_width + (end_width-start_width)*t)/2, fill)

    def finish(self):
        image = self.image.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
        alpha = image.getchannel("A")
        ImageDraw.Draw(alpha).rectangle((0, 0, SIZE-1, SIZE-1), outline=0, width=1)
        image.putalpha(alpha)
        return image


def _group(pose):
    return int(pose) // 2


def _fraction(pose):
    return pose - _group(pose)*2


def _interpolate(pose, values):
    group = _group(pose)*2
    return values[group] + (values[group+1]-values[group])*_fraction(pose)


def _pose(pose):
    # Actual geometry interpolates inside each pair: no alpha crossfades or
    # whole-frame morphing. Firmware is free to choose its own easing/timing.
    return _interpolate(pose, (0.0, 1.0, -0.5, 1.0, -0.65, 0.85, -0.6, 0.9))


def _shadow(c, x=175, y=307, rx=87, ry=10):
    c.ellipse((x-rx, y-ry, x+rx, y+ry), (40, 47, 41, 24))


def _feet(c, left, right, y, color, w=30, h=12):
    c.ellipse((left-w, y-h, left+w, y+h), color)
    c.ellipse((right-w, y-h, right+w, y+h), color)


def _eye(c, anchor, expression, look, tint=CREAM, ink=INK, emotion="warm"):
    x, y, rx, ry = anchor
    stroke = 4.6 if rx >= 18 else 4
    speaking = expression == "listening"
    if expression in ("done", "booped") or (speaking and emotion == "happy"):
        c.arc((x-rx*.80, y-ry*.10, x+rx*.80, y+ry*.67), 193, 347, ink, stroke)
        return
    if expression == "blink":
        c.line([(x-rx*.78, y+3), (x+rx*.78, y+3)], ink, stroke)
        return
    if expression == "asleep":
        c.arc((x-rx*.8, y-ry*.7, x+rx*.8, y+ry*.12), 8, 172, ink, stroke)
        return
    feeling = {"excited": 1.14, "gentle": .80, "sad": .83, "thoughtful": .86,
               "curious": 1.13 if x < 175 else .93, "angry": .86}.get(emotion, 1.0) if speaking else 1.0
    height = ry * (1.12 if expression == "attention" else feeling)
    c.ellipse((x-rx, y-height, x+rx, y+height), tint)
    dx = (look - (.65 if speaking and emotion == "thoughtful" else 0)) * rx*.12
    dy = 4 if expression == "offline" or (speaking and emotion == "sad") else -2 if expression == "attention" or (speaking and emotion == "excited") else 0
    prx, pry = rx*.47, ry*.55
    c.ellipse((x-prx+dx, y-pry+dy+1, x+prx+dx, y+pry+dy+1), ink)
    c.circle(x+rx*.13+dx, y-ry*.27+dy, max(2.7, rx*.14), "#ffffff")
    if expression == "working" or (speaking and emotion == "angry"):
        sign = 1 if x < 175 else -1
        c.line([(x-rx*.80, y-height-8-sign*2), (x+rx*.70, y-height-8+sign*3)], ink, 3)
    elif expression == "offline" or (speaking and emotion == "sad"):
        # Concerned rather than dead eyes: an unavailable connection is temporary.
        sign = 1 if x < 175 else -1
        c.line([(x-rx*.75, y-height-6+sign*2), (x+rx*.75, y-height-6-sign*2)], ink, 2.8)
    elif speaking and emotion in ("curious", "thoughtful", "excited"):
        offset = -3 if emotion == "curious" and x < 175 else 0
        c.arc((x-rx*.74, y-height-11+offset, x+rx*.74, y-height+1+offset), 205, 335, ink, 2.6)


def _mouth(c, x, y, expression, level=0, width=16, ink="#614653", tongue="#d795a0", emotion="warm"):
    if expression == "listening" and level > 0:
        rx = width * (.24 + level*.115)
        ry = 2 + level*2.8
        c.ellipse((x-rx, y-ry, x+rx, y+ry), ink)
        if level >= 3:
            c.ellipse((x-rx*.55, y+ry*.23, x+rx*.60, y+ry*.80), tongue)
    elif expression == "asleep":
        c.ellipse((x-3, y-4, x+3, y+2), ink)
    elif expression == "attention":
        c.ellipse((x-4, y-5, x+4, y+3), ink)
    elif expression == "offline" or (expression == "listening" and emotion == "sad"):
        c.arc((x-width*.55, y-2, x+width*.55, y+10), 198, 342, ink, 3)
    elif expression == "listening" and emotion in ("angry", "thoughtful"):
        c.line([(x-width*.5, y), (x+width*.5, y)], ink, 3)
    else:
        c.arc((x-width, y-12, x+width, y+8), 10, 170, ink, 3.5)


def _cheeks(c, x1, x2, y, expression, color="#dca79e", w=12):
    if expression == "offline":
        return
    for x in (x1, x2):
        c.ellipse((x-w, y-4.5, x+w, y+4.5), color)


# --- Tim: the approved purple octopus ---------------------------------------
def _tim_body(c):
    # Exact approved, resting head geometry in local ORIGIN=(152,145) space.
    c.ellipse((55, 28, 285, 238), "#9974af")
    c.ellipse((66, 34, 263, 218), "#a381bc")
    c.ellipse((96, 55, 201, 102), "#b296c6")


def _tim_parts(rear, front, pose):
    _shadow(rear, 170, 309, 109, 12)
    phase = _fraction(pose)*math.pi/2
    for i, end_x in enumerate((40, 73, 110, 151, 192, 232, 272, 313)):
        start = (141+i*8, 191)
        end = (end_x, 269+18*math.sin(i*1.8)+5*math.sin(phase+i))
        if _group(pose) == 1 and i in (0, 2, 5, 7):
            end = (end_x+2*math.sin(phase+i), end[1]-18-10*math.sin(phase*2+i))
        if _group(pose) == 2 and i == 7:
            end = (309+5*math.sin(phase), 138+8*math.sin(phase))
        if _group(pose) == 3 and i in (0, 7):
            end = (end_x+(-4 if i == 0 else 4), end[1]-(86+16*_fraction(pose)))
        points = cubic(start, (start[0]+(end_x-168)*.2, 265),
                       (end[0]-18*math.cos(i), end[1]+34), end, 64)
        rear.line(points, "#78558e" if i % 2 else "#624778", 24)
        rear.line([(x, y+5) for x, y in points[32:]], "#b592b4", 6)


def _tim_face(c, expression, look, level, emotion):
    # Preserve the original large, creamy eyes and delicate smile; no body
    # recolouring, squash, or touching eye geometry leaks into the static layer.
    for x in (125, 215):
        if expression == "listening" and emotion != "warm":
            _eye(c, (x, 142, 22, 25), expression, look, "#f8f0df", "#302d45", emotion)
        elif expression in ("done", "booped"):
            c.arc((x-16, 137, x+16, 162), 193, 347, "#352d49", 6)
        elif expression == "blink":
            c.line([(x-15, 147), (x+14, 147)], "#352d49", 6)
        elif expression == "asleep":
            c.arc((x-16, 133, x+16, 155), 10, 170, "#514762", 6)
        else:
            height = 29 if expression == "attention" else 25
            c.ellipse((x-22, 142-height, x+22, 142+height), "#f8f0df")
            dx = look*5
            dy = 4 if expression == "offline" else -3 if expression == "attention" else 0
            c.ellipse((x-8+dx, 130+dy, x+12+dx, 156+dy), "#302d45")
            c.ellipse((x+1+dx, 133+dy, x+7+dx, 139+dy), "#ffffff")
            if expression == "working":
                points = [(x-17, 111), (x+12, 117)] if x == 125 else [(x-12, 117), (x+17, 111)]
                c.line(points, "#775784", 3)
    if expression != "offline":
        cheeks = "#d49bb6" if expression in ("booped", "done") else "#c893b0"
        c.ellipse((90, 167, 111, 178), cheeks)
        c.ellipse((229, 167, 250, 178), cheeks)
    if expression == "listening" and level > 0:
        rx, ry = (5, 8, 11, 14, 17)[level], (2, 4, 7, 11, 15)[level]
        c.ellipse((170-rx, 180-ry, 170+rx, 180+ry), "#50334f")
        if level >= 3:
            c.ellipse((163, 184, 177, 188+(level-3)*3), "#d797b1")
    elif expression == "asleep":
        c.ellipse((166, 173, 174, 179), "#6f4c70")
    elif expression == "attention":
        c.ellipse((165, 172, 175, 180), "#50334f")
    elif expression == "offline" or (expression == "listening" and emotion in ("sad", "angry", "thoughtful")):
        c.line([(157, 180), (183, 180)], "#6e6079", 3)
    else:
        c.arc((151, 159, 191, 189), 10, 170, "#50334f", 4)


# --- GNU: compact shoulders, long face, hooked horns, pale beard ------------
def _gnu_body(c):
    _feet(c, 129, 219, 304, "#656955", 30, 11)
    c.ellipse((87, 221, 263, 306), "#747b66")
    c.shape((135, 194), [((145, 170), (204, 171), (216, 198)),
                          ((227, 235), (227, 291), (203, 300)),
                          ((175, 309), (145, 303), (133, 290)),
                          ((121, 256), (119, 220), (135, 194))], "#8c9276")
    c.ellipse((105, 102, 245, 213), "#9ca386")
    c.ellipse((112, 108, 225, 195), "#adb293")
    c.ellipse((137, 146, 213, 239), "#a5ab8a")
    c.ellipse((124, 205, 226, 250), "#bec19f")
    c.ellipse((130, 207, 216, 238), "#cacbad")
    # An off-centre forelock is visible even on the compact portrait.
    c.shape((147, 112), [((140, 97), (143, 85), (157, 76)),
                         ((154, 91), (161, 90), (168, 70)),
                         ((175, 84), (182, 83), (185, 73)),
                         ((196, 81), (199, 96), (204, 106)),
                         ((185, 118), (164, 116), (147, 112))], "#e7ddbe")


def _gnu_parts(rear, front, pose):
    _shadow(rear, 175, 310, 94, 9)
    sway = _pose(pose)
    lift = -5 if pose >= 4 else 0
    # The horn ends hook up and inward: a wildebeest rather than a generic bull.
    for s in (-1, 1):
        p = [(175+s*46, 114), (175+s*89, 120+sway*2),
             (175+s*111, 81+lift), (175+s*85, 61+lift)]
        points = cubic(*p)
        rear.tube(points, "#746d55", 24, 4)
        rear.tube([(x-s*3, y-4) for x, y in points], "#d8c99c", 17, 2)
        ex = 175+s*88
        ey = 136 + (sway*3 if s == 1 else 0)
        rear.shape((175+s*54, 121), [((ex+s*33, ey-13), (ex+s*40, ey+16), (ex, ey+20)),
                                    ((ex-s*20, ey+20), (175+s*65, 136), (175+s*54, 121))], "#8b9478")
        rear.line([(175+s*72, 134), (ex+s*10, ey+7)], "#c2be9c", 8)
    # A soft scalloped beard can sway without moving the muzzle above it.
    dx = sway*4
    front.shape((139, 242), [((152, 246), (199, 248), (213, 242)),
                            ((218, 259), (205+dx, 291), (196+dx, 295)),
                            ((194+dx, 283), (186+dx, 301), (177+dx, 305)),
                            ((174+dx, 291), (166+dx, 301), (157+dx, 294)),
                            ((151+dx, 282), (137, 265), (139, 242))], "#ddd6b6")
    front.curve((159, 257), (163, 275), (166+dx, 284), (170+dx, 287), "#c4bfa1", 3)
    front.curve((188, 257), (190, 274), (190+dx, 282), (187+dx, 287), "#c4bfa1", 3)


def _gnu_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["gnu"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    c.ellipse((145, 216, 158, 223), "#656956")
    c.ellipse((192, 216, 205, 223), "#656956")
    _mouth(c, 175, 237, expression, level, 19, "#727259", emotion=emotion)


# --- Lynx: high ear tufts, flared cheek ruff and black-tipped bobtail ---------
def _lynx_body(c):
    c.ellipse((110, 201, 239, 302), "#799675")
    c.ellipse((133, 213, 216, 291), "#dadfc1")
    c.ellipse((94, 259, 150, 306), "#91aa84")
    c.ellipse((198, 259, 254, 306), "#91aa84")
    # Ruff silhouette: deliberately broad cheeks below a narrower ear line.
    c.polygon([(100, 136), (81, 161), (62, 174), (81, 181), (67, 195),
               (88, 198), (87, 213), (121, 223), (173, 229), (227, 223),
               (260, 212), (259, 199), (280, 195), (266, 181), (284, 174),
               (262, 160), (246, 135)], "#cbd5b1")
    c.ellipse((86, 93, 260, 217), "#8eaa81")
    c.ellipse((100, 101, 245, 200), "#a2b992")
    c.ellipse((137, 177, 180, 211), "#e8e8cf")
    c.ellipse((166, 177, 209, 211), "#e8e8cf")
    c.ellipse((150, 190, 195, 219), "#e8e8cf")
    c.line([(151, 106), (154, 119)], "#748e6d", 6)
    c.line([(172, 104), (172, 118)], "#748e6d", 6)
    c.line([(193, 106), (190, 119)], "#748e6d", 6)
    for x, y in ((114, 252), (234, 252), (105, 274), (242, 273)):
        c.ellipse((x-6, y-4, x+6, y+4), "#6b8668")


def _lynx_parts(rear, front, pose):
    _shadow(rear, 175, 310, 81, 9)
    sway = _pose(pose)
    tail = cubic((231, 279), (266, 282), (282, 278-sway*8), (281, 259-sway*8))
    rear.line(tail, "#8caa80", 22)
    rear.line(tail[-14:], "#465e52", 22)
    for s in (-1, 1):
        twitch = sway*3 if s == 1 else 0
        base_x = 174+s*53
        tip_x = 174+s*80+twitch
        rear.shape((base_x-s*30, 126), [((base_x-s*10, 91), (tip_x-s*4, 63), (tip_x, 68)),
                                       ((tip_x+s*15, 92), (base_x+s*41, 118), (base_x+s*28, 146)),
                                       ((base_x+s*9, 142), (base_x-s*15, 135), (base_x-s*30, 126))], "#7e9b78")
        rear.polygon([(base_x-s*5, 112), (tip_x, 80), (base_x+s*18, 129)], "#c9bb9d")
        for shift in (-4, 1, 6):
            rear.curve((tip_x+shift, 79), (tip_x+shift-s*1, 61),
                       (tip_x+shift+s*5, 51), (tip_x+shift+s*5, 47), "#40594d", 4)
    # All forelegs belong to the pose layer. Lifting a paw therefore replaces
    # its resting leg instead of accidentally giving the cat a fifth limb.
    front.roundrect((133, 247, 168, 306), 15, "#aabc95")
    front.ellipse((124, 293, 174, 315), "#d9dfbd")
    for x in (143, 153):
        front.line([(x, 303), (x, 308)], "#869778", 2.4)
    if pose >= 4:
        end = (270, 194+sway*9) if pose < 6 else (273, 165+sway*10)
        front.curve((226, 253), (249, 246), (269, 228), end, "#a0b98d", 24)
        front.ellipse((end[0]-14, end[1]-14, end[0]+14, end[1]+13), "#d9dfbd")
        front.ellipse((end[0]-6, end[1]-4, end[0]+6, end[1]+5), "#c2a69e")
    else:
        front.roundrect((179, 247, 214, 306), 15, "#aabc95")
        front.ellipse((172, 293, 222, 315), "#d9dfbd")
        for x in (190, 200):
            front.line([(x, 303), (x, 308)], "#869778", 2.4)


def _lynx_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["lynx"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    c.shape((165, 184), [((169, 180), (180, 180), (183, 184)),
                         ((181, 189), (177, 193), (173, 192)),
                         ((170, 190), (168, 189), (165, 184))], "#756866")
    c.line([(173, 190), (173, 199)], "#766861", 2.5)
    if expression == "listening" and level > 0:
        _mouth(c, 173, 206, expression, level, 15, emotion=emotion)
    else:
        c.arc((159, 192, 173, 204), 2, 158, "#766861", 2.6)
        c.arc((173, 192, 187, 204), 22, 178, "#766861", 2.6)
    for s in (-1, 1):
        c.line([(173+s*38, 185), (173+s*67, 180)], "#7a9271", 2.5)
        c.line([(173+s*38, 194), (173+s*64, 199)], "#7a9271", 2.5)


# --- Mutt: scruffy terracotta dog, one lop ear, loyal wag and postal collar ---
def _mutt_body(c):
    c.ellipse((111, 211, 242, 306), "#b77652")
    c.ellipse((139, 220, 217, 303), "#efd2a4")
    c.ellipse((101, 94, 253, 228), "#c98e64")
    c.ellipse((116, 101, 238, 216), "#d5a176")
    # Tufts interrupt the edge and give Mutt a scruffier profile than GNU/Yak.
    c.polygon([(114, 161), (86, 171), (98, 182), (83, 194), (104, 199), (106, 216),
               (130, 218), (176, 229), (224, 219), (247, 212), (249, 195),
               (264, 185), (247, 180), (254, 166), (230, 156)], "#cf966c")
    c.ellipse((142, 176, 215, 231), "#efd1a9")
    c.ellipse((133, 171, 181, 213), "#efd1a9")
    c.ellipse((173, 171, 221, 213), "#efd1a9")
    c.polygon([(148, 104), (145, 90), (160, 96), (167, 82), (179, 98), (189, 88), (196, 106)], "#c98e64")
    c.curve((126, 227), (150, 240), (202, 241), (226, 225), "#6c968f", 11)
    # A tiny solid tag instead of text, readable at 160 px.
    c.circle(177, 244, 10, "#ddbc70")
    c.circle(177, 241, 2, "#977c4c")


def _mutt_parts(rear, front, pose):
    _shadow(rear, 176, 311, 86, 9)
    sway = _pose(pose)
    tail = cubic((232, 272), (277, 287), (299, 252-sway*14), (290+sway*8, 232-sway*12))
    rear.line(tail, "#ab6d47", 18)
    rear.line(tail[-12:], "#ecd0a1", 17)
    # One ear points out, the other folds down: Mutt's strongest identifier.
    rear.shape((125, 114), [((106, 83), (77, 79-sway*2), (59, 93-sway*2)),
                            ((51, 109), (59, 144), (72, 174)),
                            ((84, 190), (106, 184), (110, 166)),
                            ((104, 145), (122, 135), (125, 114))], "#8f593f")
    rear.shape((231, 107), [((255, 85), (279, 95+sway*2), (282, 119)),
                            ((286, 151), (281, 182), (265, 196)),
                            ((250, 208), (236, 194), (241, 176)),
                            ((244, 142), (233, 130), (231, 107))], "#a66a46")
    rear.curve((86, 107), (76, 124), (82, 148), (87, 160), "#bd8460", 8)
    front.roundrect((120, 258, 155, 306), 16, "#c98d63")
    front.ellipse((110, 294, 162, 316), "#e6bb89")
    if pose >= 4:
        end = (276+sway*4, 209-sway*9) if pose < 6 else (279+sway*3, 180-sway*9)
        front.curve((223, 256), (255, 268), (281, 240), end, "#c98d63", 27)
        front.ellipse((end[0]-15, end[1]-17, end[0]+15, end[1]+13), "#e3b887")
        front.ellipse((end[0]-7, end[1]-4, end[0]+7, end[1]+5), "#bc8976")
    else:
        front.roundrect((196, 258, 230, 306), 16, "#c98d63")
        front.ellipse((188, 294, 240, 316), "#e6bb89")


def _mutt_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["mutt"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    c.shape((166, 180), [((171, 175), (191, 176), (194, 181)),
                         ((196, 189), (184, 196), (178, 196)),
                         ((173, 195), (163, 188), (166, 180))], "#514447")
    c.ellipse((171, 180, 182, 184), "#8c7770")
    c.line([(178, 194), (178, 204)], "#825b4d", 2.8)
    _mouth(c, 178, 210, expression, level, 17, "#825b4d", emotion=emotion)
    if expression in ("done", "booped"):
        c.roundrect((178, 213, 190, 228), 6, "#d48686")
        c.line([(184, 216), (184, 221)], "#b96e72", 1.5)
    for x, y in ((148, 193), (155, 199), (204, 193), (201, 201)):
        c.circle(x, y, 1.6, "#b58f72")


# --- Yak: broad shaggy coat, low fringe, small ears and upturned horns -------
def _yak_body(c):
    _feet(c, 126, 224, 306, "#68504b", 27, 10)
    c.shape((92, 171), [((91, 123), (128, 100), (176, 105)),
                        ((219, 100), (259, 123), (260, 168)),
                        ((276, 205), (278, 261), (270, 297)),
                        ((255, 291), (248, 315), (235, 302)),
                        ((226, 307), (217, 317), (210, 304)),
                        ((198, 322), (187, 311), (176, 305)),
                        ((161, 320), (154, 313), (146, 303)),
                        ((132, 318), (123, 308), (116, 304)),
                        ((96, 311), (99, 295), (82, 299)),
                        ((79, 248), (80, 203), (92, 171))], "#90675a")
    c.shape((117, 155), [((126, 123), (161, 115), (195, 120)),
                         ((244, 125), (249, 173), (246, 216)),
                         ((244, 254), (238, 280), (219, 292)),
                         ((184, 300), (149, 291), (127, 278)),
                         ((106, 241), (98, 193), (117, 155))], "#a87c69")
    c.ellipse((107, 106, 242, 224), "#b68d76")
    c.ellipse((125, 189, 225, 248), "#d4b19a")
    c.ellipse((131, 192, 216, 237), "#e0bea3")
    # The fringe sits above the eyes. Long, soft points establish a yak rather
    # than a second horned GNU and remain readable when downsampled.
    c.shape((93, 139), [((93, 94), (127, 77), (178, 77)),
                        ((224, 80), (256, 111), (253, 145)),
                        ((244, 142), (237, 157), (227, 153)),
                        ((216, 138), (206, 137), (202, 153)),
                        ((190, 149), (187, 128), (182, 143)),
                        ((173, 160), (167, 144), (161, 139)),
                        ((153, 160), (144, 153), (137, 142)),
                        ((125, 153), (123, 151), (120, 143)),
                        ((107, 157), (97, 149), (93, 139))], "#895f52")
    c.curve((126, 109), (149, 92), (173, 93), (190, 99), "#a57966", 6)
    for x, y in ((113, 238), (126, 259), (226, 256), (244, 236)):
        c.curve((x, y), (x-3, y+10), (x+3, y+20), (x, y+27), "#966c5d", 3.6)


def _yak_parts(rear, front, pose):
    _shadow(rear, 175, 311, 101, 9)
    sway = _pose(pose)
    for s in (-1, 1):
        rear.ellipse((175+s*89-26, 143, 175+s*89+26, 166), "#825c50")
        horn = cubic((175+s*65, 124), (175+s*119, 119),
                     (175+s*132, 78+sway*2), (175+s*99, 65+sway*2))
        rear.tube(horn, "#d6c5a6", 24, 3)
        rear.tube([(x-s*3, y-3) for x, y in horn], "#ecddbd", 13, 1)
    # A small chewing jaw and beard, independent of the shaggy torso.
    front.shape((151, 245), [((163, 250), (188, 250), (203, 245)),
                            ((199+sway*3, 266), (184+sway*3, 279), (179+sway*3, 272)),
                            ((169+sway*3, 283), (157+sway*3, 266), (151, 245))], "#825c51")
    if pose >= 4:
        ex, ey = 287, 205-sway*10 if pose < 6 else 173-sway*10
        front.curve((250, 245), (280, 252), (290, 235), (ex, ey), "#a57a66", 24)
        front.ellipse((ex-13, ey-13, ex+13, ey+13), "#69534c")


def _yak_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["yak"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    c.ellipse((141, 212, 153, 219), "#8e7164")
    c.ellipse((197, 212, 209, 219), "#8e7164")
    _mouth(c, 175, 233, expression, level, 19, "#8e7164", emotion=emotion)


# --- Gopher: popping out of a burrow, round cheeks and two clear incisors -----
def _gopher_body(c):
    c.ellipse((112, 178, 239, 305), "#b28b51")
    c.ellipse((130, 203, 219, 301), "#e6c78e")
    c.ellipse((111, 95, 151, 133), "#bb9157")
    c.ellipse((199, 95, 239, 133), "#bb9157")
    c.ellipse((120, 102, 145, 128), "#dcb28a")
    c.ellipse((205, 102, 230, 128), "#dcb28a")
    c.ellipse((94, 109, 256, 228), "#c69b60")
    c.ellipse((104, 117, 243, 216), "#d9b171")
    c.ellipse((88, 163, 148, 214), "#d8af75")
    c.ellipse((202, 163, 262, 214), "#d8af75")
    c.ellipse((131, 176, 178, 216), "#efdab0")
    c.ellipse((172, 176, 219, 216), "#efdab0")
    c.ellipse((149, 188, 202, 228), "#efdab0")
    c.ellipse((143, 119, 179, 133), "#e4c08a")
    # The dark burrow is part of the physical silhouette, not an unread badge.
    c.ellipse((76, 283, 274, 321), "#725d49")
    c.ellipse((87, 291, 262, 316), "#4f493e")
    _feet(c, 132, 218, 300, "#c99f68", 25, 11)


def _gopher_parts(rear, front, pose):
    _shadow(rear, 175, 317, 105, 7)
    sway = _pose(pose)
    for s in (-1, 1):
        start = (175+s*54, 234)
        if pose >= 4 and s == 1:
            end = (267+sway*5, 193-sway*8 if pose < 6 else 165-sway*8)
        elif _group(pose) == 1:
            end = (175+s*(59+sway*3), 278+sway*s*5)
        else:
            end = (175+s*57, 275+sway*s*2)
        front.curve(start, (start[0]+s*17, 232), (end[0]+s*4, end[1]-20), end, "#b88f54", 27)
        front.ellipse((end[0]-16, end[1]-10, end[0]+16, end[1]+11), "#ddbb80")
        for d in (-5, 3):
            front.line([(end[0]+d, end[1]+3), (end[0]+d, end[1]+8)], "#a38153", 2)
    # Two quiet ground crumbs, never particle confetti obscuring app text.
    front.ellipse((65, 305, 79, 312), "#a58c65")
    front.ellipse((276, 303, 287, 309), "#a58c65")


def _gopher_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["gopher"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    c.ellipse((163, 179, 187, 192), "#79604a")
    c.ellipse((169, 181, 177, 184), "#ac9170")
    c.line([(175, 190), (175, 201)], "#947149", 2.5)
    if expression == "listening" and level > 0:
        _mouth(c, 175, 214, expression, level, 18, "#745540", emotion=emotion)
    else:
        _mouth(c, 175, 208, expression, level, 20, "#947149", emotion=emotion)
    # The paired incisors remain visible in every state; the mouth animates
    # behind them rather than replacing a species-defining feature.
    c.roundrect((165, 207, 174, 221), 2, "#fff4dc")
    c.roundrect((176, 207, 185, 221), 2, "#fff4dc")
    _cheeks(c, 109, 242, 184, expression, "#dfab8d", 10)


# --- Bug: the Mark II moth, broad four-part wings and feathery antennae -------
def _bug_body(c):
    c.ellipse((150, 142, 200, 287), "#8c8b68")
    c.ellipse((155, 152, 191, 278), "#b8b592")
    for y, w in ((223, 18), (243, 17), (263, 12)):
        c.curve((175-w, y), (169, y+5), (183, y+5), (175+w, y), "#9a9875", 4)
    c.ellipse((131, 120, 219, 211), "#bbb99c")
    c.ellipse((139, 124, 210, 200), "#d0cdb0")
    c.shape((136, 141), [((130, 137), (135, 124), (143, 127)),
                         ((144, 116), (154, 115), (159, 123)),
                         ((165, 111), (174, 112), (176, 122)),
                         ((186, 112), (195, 119), (194, 127)),
                         ((207, 119), (219, 131), (212, 142)),
                         ((198, 149), (151, 151), (136, 141))], "#d7d3b7")


def _bug_parts(rear, front, pose):
    _shadow(rear, 175, 307, 69, 8)
    sway = _pose(pose)
    wing_open = _interpolate(pose, (0, -6, -4, 7, 6, -2, 9, -4))
    for s in (-1, 1):
        def P(x, y):
            return (175+s*x, y)
        # Four unmistakable scalloped wings: unlike a generic butterfly, the
        # upper pair is broad and swept, in dusty moth colours.
        rear.shape(P(10, 159), [(P(47, 99), P(115+wing_open, 87), P(124+wing_open, 132)),
                                (P(130+wing_open, 165), P(111+wing_open, 189), P(94, 215)),
                                (P(71, 233), P(37, 219), P(11, 188)),
                                (P(6, 176), P(7, 165), P(10, 159))], "#99977b")
        rear.shape(P(14, 168), [(P(54, 114), P(104+wing_open, 110), P(104+wing_open, 147)),
                                (P(105+wing_open, 173), P(81, 196), P(57, 205)),
                                (P(35, 199), P(21, 185), P(14, 168))], "#c6be98")
        rear.shape(P(11, 198), [(P(45, 199), P(109, 218+wing_open), P(99, 253+wing_open)),
                                (P(94, 273), P(72, 297), P(49, 278)),
                                (P(31, 284), P(16, 248), P(11, 222)),
                                (P(8, 214), P(9, 206), P(11, 198))], "#85876c")
        rear.shape(P(17, 211), [(P(47, 218), P(90, 225+wing_open), P(80, 249+wing_open)),
                                (P(69, 271), P(42, 268), P(27, 242)),
                                (P(23, 231), P(19, 219), P(17, 211))], "#b0af88")
        ex, ey = P(80+wing_open*.5, 162)
        rear.ellipse((ex-20, ey-25, ex+20, ey+25), "#7b7b67")
        rear.ellipse((ex-13, ey-18, ex+13, ey+18), "#e3d4ac")
        rear.ellipse((ex-7, ey-10, ex+7, ey+10), "#8a715d")
        rear.curve(P(20, 178), P(46, 162), P(70, 139), P(97+wing_open, 124), "#afa480", 3)
        # A moth's antennae are little combs, not hard spheres on wire.
        ant = cubic(P(15, 137), P(28, 108), P(35+sway*3, 80), P(47+sway*4, 71))
        rear.line(ant, "#817c65", 4)
        for i in (14, 23, 32, 41):
            x, y = ant[i]
            rear.line([(x, y), (x+s*9, y+3)], "#a49e7b", 3)
        for i in range(3):
            root = P(18, 209+i*19)
            end = P(35+i*4, 226+i*24+sway*s*2)
            if pose >= 4 and i == 0 and s == 1:
                end = P(44+sway*4, 172+sway*7)
            front.curve(root, P(35, root[1]), P(35+i*4, end[1]-4), end, "#73765b", 4)


def _bug_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["bug"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    _cheeks(c, 137, 213, 192, expression, "#c9a89b", 8)
    _mouth(c, 175, 203, expression, level, 11, "#696650", emotion=emotion)


# --- Tux 1363: midnight-blue pear, cream bib, a small pink bow tie ------------
def _tux_body(c):
    _feet(c, 136, 214, 302, "#c69265", 31, 14)
    c.ellipse((106, 93, 245, 225), "#3e4f83")
    c.shape((115, 162), [((97, 194), (88, 235), (97, 273)),
                         ((102, 300), (131, 312), (175, 310)),
                         ((215, 313), (245, 298), (253, 274)),
                         ((263, 235), (252, 191), (235, 162)),
                         ((216, 144), (137, 144), (115, 162))], "#354675")
    c.ellipse((107, 72, 243, 211), "#40548d")
    c.ellipse((117, 78, 229, 197), "#4c619a")
    c.shape((119, 168), [((127, 158), (159, 165), (175, 172)),
                         ((190, 163), (222, 158), (231, 172)),
                         ((248, 209), (247, 251), (227, 277)),
                         ((205, 300), (148, 302), (124, 279)),
                         ((100, 253), (105, 203), (119, 168))], "#c6cfe1")
    c.ellipse((121, 196, 227, 287), "#dae0e7")
    c.ellipse((116, 112, 169, 182), "#d8dfeb")
    c.ellipse((181, 112, 234, 182), "#d8dfeb")
    c.ellipse((145, 88, 196, 106), "#687cae")
    # The sample's characteristic pink bow tie, not a recoloured standard Tux.
    c.shape((172, 212), [((160, 202), (147, 200), (144, 205)),
                         ((141, 215), (145, 230), (151, 230)),
                         ((161, 230), (164, 223), (172, 220)),
                         ((172, 217), (172, 214), (172, 212))], "#d8759b")
    c.shape((178, 212), [((190, 202), (203, 200), (206, 205)),
                         ((209, 215), (205, 230), (199, 230)),
                         ((189, 230), (186, 223), (178, 220)),
                         ((178, 217), (178, 214), (178, 212))], "#d8759b")
    c.roundrect((168, 209, 182, 224), 5, "#ef94b5")


def _tux_parts(rear, front, pose):
    _shadow(rear, 175, 313, 90, 9)
    sway = _pose(pose)
    for s in (-1, 1):
        start = (175+s*65, 193)
        if _group(pose) == 2 and s == -1:
            end = (64+sway*8, 116+sway*10)
        elif pose >= 6:
            end = (175+s*(118+sway*4), 161-sway*13)
        elif _group(pose) == 1:
            end = (175+s*(112+sway*5), 248+sway*s*6)
        else:
            end = (175+s*111, 259+sway*s*3)
        points = cubic(start, (start[0]+s*31, 192), (end[0]+s*7, end[1]-13), end)
        rear.tube(points, "#344575", 30, 12)
        rear.tube([(x-s*4, y-3) for x, y in points[5:]], "#4e649d", 10, 3)


def _tux_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["tux"]["eyes"]:
        _eye(c, eye, expression, look, "#f5f0dd", "#2d3450", emotion)
    # The lower beak opens with the shared listening amplitude; eyes stay put.
    gap = level*2.1 if expression == "listening" else 3 if expression == "attention" else 0
    if gap:
        c.ellipse((164, 177, 188, 188+gap), "#573b48")
    c.shape((155, 177), [((161, 170), (187, 170), (195, 177)),
                         ((192, 184), (180, 187), (175, 187)),
                         ((168, 186), (159, 183), (155, 177))], "#d5a179")
    c.shape((162, 185+gap), [((173, 190+gap), (181, 190+gap), (190, 185+gap)),
                             ((185, 198+gap), (166, 198+gap), (162, 185+gap))], "#bd865e")
    c.curve((164, 179), (171, 181), (181, 181), (189, 179), "#e8bc8f", 2.3)


# --- Auk: upright seabird, side-facing hooked/grooved bill and white patch ---
def _auk_body(c):
    _feet(c, 154, 215, 305, "#3e514e", 29, 10)
    c.shape((134, 133), [((130, 102), (147, 77), (177, 77)),
                         ((221, 76), (233, 112), (225, 151)),
                         ((254, 183), (270, 232), (252, 275)),
                         ((242, 305), (216, 313), (176, 306)),
                         ((149, 307), (126, 288), (126, 264)),
                         ((116, 233), (134, 187), (134, 133))], "#305a67")
    c.shape((153, 156), [((179, 143), (198, 170), (213, 199)),
                         ((234, 232), (237, 270), (218, 290)),
                         ((200, 306), (160, 299), (145, 281)),
                         ((122, 249), (140, 205), (153, 156))], "#d9deca")
    c.ellipse((144, 90, 202, 112), "#547984")
    # A great auk's white oval in front of its eye, not a Tux face/bib.
    c.ellipse((133, 104, 185, 166), "#e1e5d3")
    c.shape((243, 231), [((265, 245), (278, 264), (281, 285)),
                         ((263, 281), (247, 276), (232, 262)),
                         ((226, 250), (230, 238), (243, 231))], "#31515b")


def _auk_parts(rear, front, pose):
    _shadow(rear, 183, 313, 81, 8)
    sway = _pose(pose)
    # A tiny wing rows from a consistent root. The long bill provides the other
    # silhouette cue, so the bird stays recognisable even with its wing lifted.
    start = (225, 196)
    if _group(pose) == 2:
        end = (292+sway*4, 151+sway*9)
    elif pose >= 6:
        end = (299, 185+sway*11)
    elif _group(pose) == 1:
        end = (285+sway*6, 251+sway*5)
    else:
        end = (257+sway*2, 273+sway*2)
    wing = cubic(start, (255, 198), (end[0]+8, end[1]-22), end)
    front.tube(wing, "#244a56", 29, 6)
    front.tube([(x-6, y+1) for x, y in wing[16:]], "#8fa9a8", 7, 1)
    # A smooth stone anchors this taller animal without adding stage clutter.
    rear.ellipse((101, 296, 265, 324), "#9caaa0")
    rear.ellipse((110, 296, 255, 313), "#b7c1b4")


def _auk_face(c, expression, look, level, emotion):
    _eye(c, FACE_ANCHORS["auk"]["eyes"][0], expression, look, "#f6f0dc", "#2e3f47", emotion)
    # Deep hooked bill with three quiet ivory grooves from the species plate.
    gap = level*2.3 if expression == "listening" else 3 if expression == "attention" else 0
    if gap:
        c.polygon([(83, 161), (144, 156), (143, 169+gap), (92, 173+gap)], "#263d45")
    c.shape((145, 141), [((120, 127), (87, 133), (73, 148)),
                         ((66, 156), (70, 170), (80, 175)),
                         ((82, 163), (111, 162), (145, 162)),
                         ((147, 154), (146, 148), (145, 141))], "#42626b")
    c.shape((85, 168+gap), [((111, 163+gap), (128, 164+gap), (142, 163+gap)),
                             ((139, 178+gap), (104, 183+gap), (85, 168+gap))], "#38555f")
    for x, y in ((103, 140), (117, 138), (131, 140)):
        c.curve((x, y), (x-4, y+6), (x-2, y+13), (x+1, y+17), "#c6cfbd", 2.8)
    c.arc((132, 153, 151, 176), 36, 92, "#76918d", 2.7)


# --- Beastie: friendly BSD imp, horns, spade tail, sneakers and trident -------
def _beastie_body(c):
    c.roundrect((134, 252, 160, 304), 12, "#be675e")
    c.roundrect((189, 252, 215, 304), 12, "#be675e")
    c.ellipse((110, 294, 163, 316), "#566987")
    c.ellipse((188, 294, 241, 316), "#566987")
    c.line([(116, 310), (159, 310)], "#e3ddd1", 4)
    c.line([(193, 310), (235, 310)], "#e3ddd1", 4)
    c.ellipse((125, 187, 224, 282), "#cd7569")
    c.ellipse((144, 206, 207, 270), "#e6a18c")
    c.ellipse((99, 88, 249, 215), "#d77b6e")
    c.ellipse((111, 97, 234, 203), "#e0917e")
    c.ellipse((137, 110, 192, 125), "#edac94")
    # Soft pointy ears, not a rigid red circle.
    c.shape((111, 126), [((97, 118), (78, 117), (76, 125)),
                         ((82, 148), (95, 157), (113, 149)),
                         ((117, 141), (115, 132), (111, 126))], "#cf7569")
    c.shape((237, 126), [((251, 118), (270, 117), (272, 125)),
                         ((266, 148), (253, 157), (235, 149)),
                         ((231, 141), (233, 132), (237, 126))], "#cf7569")
    for s in (-1, 1):
        horn = cubic((174+s*48, 101), (174+s*58, 80), (174+s*42, 65), (174+s*42, 59))
        c.tube(horn, "#ddc9a6", 23, 2)
        c.tube([(x-s*3, y) for x, y in horn], "#f2dfb9", 12, 1)


def _beastie_parts(rear, front, pose):
    _shadow(rear, 175, 313, 91, 9)
    sway = _pose(pose)
    end = (67+sway*4, 226-sway*11)
    tail = cubic((139, 267), (105, 300), (63, 273), end)
    rear.line(tail, "#bd665f", 11)
    rear.polygon([(end[0]-14, end[1]+4), (end[0]+1, end[1]-23),
                  (end[0]+14, end[1]+6), (end[0]+1, end[1]+1)], "#c36b62")
    # The familiar trident is drawn as a warm bronze tool, not an aggressive
    # weapon. Its tap is a few pixels; it never crosses the daemon's face.
    tx, ty = 285, 5*_fraction(pose)
    front.line([(tx, 294-ty), (tx, 130-ty)], "#b5955e", 6)
    front.curve((tx-20, 120-ty), (tx-22, 147-ty), (tx-11, 153-ty), (tx, 153-ty), "#b5955e", 5)
    front.curve((tx+20, 120-ty), (tx+22, 147-ty), (tx+11, 153-ty), (tx, 153-ty), "#b5955e", 5)
    for x, y in ((tx-20, 118-ty), (tx, 112-ty), (tx+20, 118-ty)):
        front.polygon([(x-6, y+5), (x, y-10), (x+6, y+5)], "#c9ab73")
    front.curve((216, 217), (244, 231), (262, 228), (281, 223-ty), "#d37a6d", 21)
    front.circle(281, 223-ty, 12, "#e0937f")
    if pose >= 4:
        end = (78+sway*7, 151+sway*9) if pose < 6 else (73+sway*5, 125+sway*7)
        front.curve((132, 218), (106, 214), (80, 179), end, "#d37a6d", 21)
        front.circle(*end, 13, "#e0937f")
        front.line([(end[0]-3, end[1]-6), (end[0]-5, end[1]-14)], "#e0937f", 6)
    else:
        front.curve((132, 216), (105, 212), (104, 247), (130, 250), "#d37a6d", 21)


def _beastie_face(c, expression, look, level, emotion):
    for eye in FACE_ANCHORS["beastie"]["eyes"]:
        _eye(c, eye, expression, look, emotion=emotion)
    _cheeks(c, 114, 234, 181, expression, "#ecad9b", 10)
    _mouth(c, 174, 194, expression, level, 22, "#844b4d", emotion=emotion)
    if expression not in ("asleep", "offline"):
        # One small fang keeps the original daemon's cheeky charm.
        c.polygon([(181, 197), (188, 195), (184, 204)], "#fff1d7")


_BODIES = {"tim": _tim_body, "gnu": _gnu_body, "lynx": _lynx_body, "mutt": _mutt_body,
           "yak": _yak_body, "gopher": _gopher_body, "bug": _bug_body, "tux": _tux_body,
           "auk": _auk_body, "beastie": _beastie_body}
_PARTS = {"tim": _tim_parts, "gnu": _gnu_parts, "lynx": _lynx_parts, "mutt": _mutt_parts,
          "yak": _yak_parts, "gopher": _gopher_parts, "bug": _bug_parts, "tux": _tux_parts,
          "auk": _auk_parts, "beastie": _beastie_parts}
_FACES = {"tim": _tim_face, "gnu": _gnu_face, "lynx": _lynx_face, "mutt": _mutt_face,
          "yak": _yak_face, "gopher": _gopher_face, "bug": _bug_face, "tux": _tux_face,
          "auk": _auk_face, "beastie": _beastie_face}


@lru_cache(maxsize=len(IDS))
def _body(daemon_id):
    c = Canvas()
    _BODIES[daemon_id](c)
    return c.finish()


@lru_cache(maxsize=160)
def _parts(daemon_id, pose):
    rear, front = Canvas(), Canvas()
    _PARTS[daemon_id](rear, front, pose)
    return rear.finish(), front.finish()


@lru_cache(maxsize=256)
def _face(daemon_id, expression, look, level, emotion):
    c = Canvas()
    _FACES[daemon_id](c, expression, look, level, emotion)
    return c.finish()


def render_layers(daemon_id, pose=0, expression="idle", look=0, level=0, emotion="warm"):
    """Return independent 350px RGBA layers in paint order.

    ``pose`` accepts floats within 0..1, 2..3, 4..5, 6..7: rest pair, focus
    pair, greeting pair, joy pair. Coordinates interpolate within each pair.
    The body
    does not depend on pose/expression/look/level. ``expression`` is one of the
    eight shared moods or ``blink``. Gaze is -2..2; listening amplitude is 0..4.
    ``emotion`` is a member of EMOTIONS and changes only a listening face.
    Each returned image is a copy: a packer may crop or composite it safely.
    """
    if daemon_id not in IDS:
        raise ValueError(f"unknown init daemon: {daemon_id!r}")
    if expression not in EXPRESSIONS:
        raise ValueError(f"unknown expression: {expression!r}")
    if not isinstance(pose, (int, float)) or not math.isfinite(pose) or not 0 <= pose <= 7 or _fraction(pose) > 1:
        raise ValueError("pose must be within 0..1, 2..3, 4..5, or 6..7")
    if not isinstance(look, int) or not -2 <= look <= 2:
        raise ValueError("look must be an integer in -2..2")
    if not isinstance(level, int) or not 0 <= level <= 4:
        raise ValueError("level must be an integer in 0..4")
    if emotion not in EMOTIONS:
        raise ValueError(f"unknown emotion: {emotion!r}")
    # Mouth amplitude has no meaning outside listening. Normalising it avoids
    # duplicating identical host cache entries and makes the contract explicit.
    if expression != "listening":
        level = 0
        emotion = "warm"
    if expression in ("blink", "done", "asleep", "booped"):
        look = 0
    rear, front = _parts(daemon_id, pose)
    return {"rear": rear.copy(), "body": _body(daemon_id).copy(),
            "front": front.copy(), "face": _face(daemon_id, expression, look, level, emotion).copy()}


def render(daemon_id, pose=0, expression="idle", look=0, level=0, emotion="warm"):
    """Flatten only for host review; firmware keeps these layers separate."""
    image = Image.new("RGBA", (SIZE, SIZE))
    for layer in render_layers(daemon_id, pose, expression, look, level, emotion).values():
        image.alpha_composite(layer)
    return image


def render_contact_sheet(output_path):
    """All ten actual rendered illustrations on one quiet, untextured sheet."""
    w, h, cols = 330, 390, 5
    sheet = Image.new("RGB", (w*cols, h*2+74), "#f2f0e9")
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 20)
        heading = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 26)
        small = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 13)
    except OSError:
        font = heading = small = ImageFont.load_default()
    draw.text((26, 22), "A little company.  /  init", fill="#3d4a43", font=heading)
    for i, daemon_id in enumerate(IDS):
        x, y = (i % cols)*w, (i // cols)*h+74
        source = render(daemon_id, 0)
        art = source.resize((300, 300), Image.Resampling.LANCZOS)
        sheet.paste(art, (x+15, y+5), art)
        draw.text((x+22, y+324), DISPLAY_NAMES[daemon_id], fill="#3d4a43", font=font)
        draw.text((x+22, y+354), DEFAULT_SCENES[daemon_id], fill="#7b8278", font=small)
        compact = source.resize((62, 62), Image.Resampling.LANCZOS)
        sheet.paste(compact, (x+245, y+307), compact)
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(path)
    return path


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contact-sheet", type=Path,
                        default=Path(__file__).resolve().parent / "review" / "daemon-art-contact.png")
    args = parser.parse_args()
    print(render_contact_sheet(args.contact_sheet))
