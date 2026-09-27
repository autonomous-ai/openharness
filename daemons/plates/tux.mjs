import { circle, ellipse, seg, tube, path, cut, blend, meet, part, eye, rng } from '../tools/plate.mjs'

// tux: the Linux penguin. Linus Torvalds said a penguin bit him at a zoo in Canberra; Larry Ewing drew the mascot in the GIMP in 1996.
//
// Every hatch is its own penguin: the seed decides its colour, markings, proportions, rare extra
// and temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 100, h: 84 }

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const mix = (a, b, k) => a + (b - a) * k

// The traits that draw today's tux: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { round: 1, flippers: 1, feet: 1, beak: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// Turn a shape by `a` radians about (cx, cy).
function turn(cx, cy, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return (d) => (x, y) => {
    const dx = x - cx, dy = y - cy
    return d(cx + dx * c + dy * s, cy - dx * s + dy * c)
  }
}

// The penguin is drawn in its own frame: origin on the floor between its feet, y down, full-grown
// units. place() scales it by s, rocks it by rot about that floor point and lifts it by hop.
function place(px, py, s, rot, hop) {
  const c = Math.cos(rot), sn = Math.sin(rot)
  const local = (x, y) => {
    const dx = x - px, dy = y - py + hop
    return [(dx * c + dy * sn) / s, (-dx * sn + dy * c) / s]
  }
  return (d) => (x, y) => s * d(...local(x, y))
}

// Body language per mood. The left flipper (the one that waves): its heading (radians, y down, so
// -PI/2 is straight up), how far it swings and how fast (turns per loop), and its curl. The right
// flipper: its heading and curl. Then a happy hop, the waddle-rock, the head's tilt and droop.
const MOODS = {
  idle: { arm: -2.5, swing: 0.22, speed: 2, curl: 0.06, rest: 1.3, restCurl: 0.035, hop: 0, sway: 0.03, tilt: -0.05, droop: 0 },
  work: { arm: 0.5, swing: 0.07, speed: 4, curl: 0.02, rest: 1.3, restCurl: 0.035, hop: 0, sway: 0.01, tilt: 0.06, droop: 0.5 },
  need: { arm: -1.75, swing: 0.14, speed: 4, curl: 0.03, rest: 1.3, restCurl: 0.035, hop: 0, sway: 0.02, tilt: -0.12, droop: 0 },
  done: { arm: -2.2, swing: 0.2, speed: 2, curl: 0.05, rest: -0.95, restCurl: -0.05, hop: 3, sway: 0.02, tilt: -0.04, droop: 0 },
  fail: { arm: 1.85, swing: 0, speed: 0, curl: -0.03, rest: 1.4, restCurl: 0.03, hop: 0, sway: 0.008, tilt: 0.1, droop: 1 },
  back: { arm: -2.3, swing: 0.38, speed: 2, curl: 0.06, rest: 1.3, restCurl: 0.035, hop: 0, sway: 0.03, tilt: -0.1, droop: 0 },
  nap: { arm: 1.85, swing: 0, speed: 0, curl: -0.03, rest: 1.4, restCurl: 0.03, hop: 0, sway: 0.012, tilt: 0.14, droop: 0.6 },
  boop: { arm: -2.95, swing: 0.04, speed: 2, curl: 0.04, rest: -0.2, restCurl: -0.04, hop: 0, sway: 0.008, tilt: 0, droop: 0 },
}

// Markings: bright ones sit on the dark hood (crest, cheeks), dark ones on the white front
// (speckles, chinstrap). Extras are painted in the extra's colour.
const mark = (tone = 0.97) => ({ tone, mat: 'marks', ink: false })
const acc = (o = {}) => ({ tone: 0.95, mat: 'acc', ink: false, ...o })

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  const g = clamp01((parseFloat(age) - 0.1) / 1.9) // 0 hatchling .. 1 full grown
  const M = MOODS[mood] || MOODS.idle
  const f = T.temper === 'fidgety' ? 2 : 1 // a fidgety penguin runs its loop twice over

  const s = mix(0.72, 1, g)
  const breath = Math.sin(t) * (mood === 'nap' ? 2.5 : 1)
  const hop = M.hop * Math.abs(Math.sin(f * t))
  const X = place(50, 82, s, M.sway * Math.sin(f * t), hop)
  const P = (d, o = {}, to = X) => part(to(d), { ...o, relief: o.relief && o.relief * s })

  // proportions: a chick is mostly head, the grown bird mostly belly; a round bird is a wider pear,
  // the head staying put so the eyes keep their text row
  const headR = 23
  const grownHeadY = mix(-48, -57, g)
  const headY = grownHeadY + M.droop * 2
  const bodyRx = mix(22, 29, g) * T.round, bodyRy = mix(20, 28, g)
  const bodyY = -bodyRy - 1
  const H = turn(0, headY + headR * 0.8, M.tilt + (mood === 'nap' ? 0.05 : 0.025) * Math.sin(f * t)) // the head's own tilt

  const backTone = 0.47
  const coatTone = mix(0.82, 0.47, g) // a chick's grey down
  const bellyTone = mix(0.92, 0.96, g)
  const fw = mix(3.8, 5.6, g), ft = mix(2.4, 2, g) // flipper root and tip radius

  const parts = []

  // body and head: one dark pear
  const body = ellipse(0, bodyY, bodyRx * (1 + 0.012 * breath), bodyRy)
  const head = H(ellipse(0, headY, headR, headR * 0.92))
  const pear = blend(14, body, head)
  parts.push(P(pear, { relief: 12, tone: backTone }))
  if (g < 1) {
    // a chick: grey down on the body, the dark head sitting on it
    parts.push(P(body, { relief: 12, tone: coatTone, ink: false }))
    parts.push(P(head, { relief: 10, tone: backTone, ink: g < 0.6 }))
  }

  // the white front: one bib from the cheeks down to the belly, under a dark hood that comes to a
  // point between the eyes (a chick has the mask, and only a hint of the bib)
  const bellyW = mix(13, 21.5, g), bellyRy = mix(12, 23, g)
  const bellyRx = bellyW * T.round * (1 + 0.02 * breath)
  const belly = ellipse(0, bodyY + 2, bellyRx, bellyRy)
  const mask = H(cut(ellipse(0, headY + headR * 0.12, headR * 0.84, headR * 0.74), circle(0, headY - headR * 0.64, headR * 0.3)))
  const bib = blend(8, belly, mask)
  parts.push(P(belly, { relief: 10, tone: bellyTone, ink: false }))
  parts.push(P(mask, { relief: 8, tone: 0.97, ink: false }))
  if (g > 0.5) parts.push(P(bib, { relief: 10, tone: 0.96, ink: false }))

  // a tuft of down on top that the grown bird has lost
  if (g < 0.8) {
    const k = 1 - g / 0.8
    parts.push(P(H(tube(path(1, headY - headR * 0.88, -1.75, 9 * k, (u) => 0.1 + 0.25 * u), 2.4 * k + 0.4, 0.5)), { relief: 1.5, tone: backTone }))
  }

  // Markings. Speckles: an African penguin's belly spots, no two birds alike (placed by the seed).
  const kx = bellyW / 21.5, ky = bellyRy / 23 // the grown bib's size, for a chick's smaller one
  if (T.marks === 'speckles') {
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * 2 * (i / 8 + 0.1 * R()), d = 0.35 + 0.55 * R()
      parts.push(P(meet(circle(Math.cos(a) * 19 * T.round * d * kx, bodyY + 3 + Math.sin(a) * 17 * d * ky, (2.3 + 1.5 * R()) * kx), bib), mark(0.22)))
    }
  }
  // Cheeks: an emperor's ear patches, down the sides of the head to the neck.
  if (T.marks === 'cheeks') {
    for (const side of [-1, 1]) parts.push(P(meet(H(seg(side * 20, headY - 1, side * 15, headY + 15, 3.9, 2.4)), pear), { relief: 2, ...mark() }))
  }
  // Chinstrap: the chinstrap penguin's thin dark line from ear to ear under the beak.
  if (T.marks === 'chinstrap') {
    const band = []
    for (let k = 0; k <= 24; k++) { const a = Math.PI * (0.1 + 0.8 * k / 24); band.push([Math.cos(a) * 18, headY + 6 + Math.sin(a) * 11.5]) }
    parts.push(P(H(tube(band, 1.9)), mark(0.3)))
  }
  // Crest: a rockhopper's yellow plumes, from the brow out past the sides of the head, drooping.
  if (T.marks === 'crest') {
    for (const side of [-1, 1]) {
      for (const [a, len, dy] of [[-0.16, 26, 0], [-0.46, 19, -1.8]]) {
        const pts = path(side * 4, headY - 8.5 + dy, side > 0 ? a : Math.PI - a, len, (u) => side * 0.085 * u)
        parts.push(P(H(tube(pts, 2, 0.6)), { relief: 1.5, ...mark() }))
      }
    }
  }

  // Rare extras. The neck sits where the grown bird's does, moved with a chick's lower head.
  const neck = grownHeadY + 57
  // A knitted scarf round the neck, one end down the front, fringed: Antarctica is cold.
  if (T.extra === 'scarf') {
    const sy = -39.5 + neck, sw = bodyRx + 2
    const wrap = meet(ellipse(0, sy, sw, 14), (x, y) => Math.abs(y - sy - 2.4 * (1 - (x / sw) ** 2)) - 3.4)
    parts.push(P(wrap, acc({ relief: 3, ink: true, tex: (x) => (Math.floor(x / 2.4) % 2 ? 1 : 0.8) })))
    const end = path(9, sy + 3, 1.42 + 0.06 * Math.sin(f * t), 19 * ky, () => -0.012)
    parts.push(P(tube(end, 3.5, 3.1), acc({ relief: 2, ink: true, tex: (x, y) => (Math.floor(y / 4) % 2 ? 1 : 0.7) })))
    const [ex, ey] = end[end.length - 1]
    for (const i of [-1.5, -0.5, 0.5, 1.5]) parts.push(P(seg(ex + i * 2, ey + 1, ex + i * 2.3, ey + 5, 0.9, 0.6), acc()))
  }
  // A bow tie: a penguin already wears the tuxedo.
  if (T.extra === 'bowtie') {
    const by = -37.5 + neck
    const bow = blend(1.2, seg(0, by, -8, by - 0.6, 1.4, 4.3), seg(0, by, 8, by - 0.6, 1.4, 4.3))
    parts.push(P(bow, acc({ relief: 2.5, ink: true })))
    parts.push(P(circle(0, by, 2.3), acc({ relief: 1.5, tone: 0.8, ink: true })))
  }

  // flippers: a chick's are stubs held out from its sides
  const fx = bodyRx - mix(1.5, 5, g), fy = bodyY - bodyRy * mix(0.3, 0.42, g), fl = mix(9, 21, g) * T.flippers
  // A flipper along a path. An individual's round body or long flippers flung wide (boop) could
  // reach past the frame, so its flipper lifts until the tip fits.
  const flipper = (x, a, curl, lift) => {
    for (let i = 0; ; i++, a += lift * 0.04) {
      const pts = path(x, fy, a, fl, (u) => curl * u)
      if (!traits || i > 30 || Math.max(...pts.map(([px]) => Math.abs(px))) + ft <= 47.5 / s) return tube(pts, fw, ft)
    }
  }

  // flipper on the right (the bird's left): down its side, the tip resting on the belly
  const rest = flipper(fx, M.rest - (1 - g) * 0.6, M.restCurl, -1)
  parts.push(P(rest, { relief: 3, tone: coatTone }))

  // flipper on the left (the bird's right): out to the side and up, a small wave (a fidgety one's wider)
  const armA = M.arm - M.swing * (f > 1 ? 1.4 : 1) * Math.sin(M.speed * f * t)
  const waving = flipper(-fx, armA, M.curl, 1)
  parts.push(P(waving, { relief: 3, tone: coatTone }))

  // feet: big and flat in front, toes splayed, planted while the body rocks; big feet grow long more
  // than tall
  const planted = place(50, 82, s, 0, hop)
  const footS = mix(0.65, 1, g), footX = footS * T.feet, footY = footS * (0.5 + 0.5 * T.feet)
  for (const side of [-1, 1]) {
    const x = side * mix(8, 11.5, g)
    const toes = [-1, 0, 1].map((i) => ellipse(x + side * 1.5 + i * 5.4 * footX, -2, 3.3 * footX, 2.7 * footY, i * 0.4))
    const foot = blend(3, ellipse(x, -3.6, 8.5 * footX, 3.2 * footY), ...toes)
    parts.push(P(foot, { relief: 2, tone: 0.72 }, planted))
  }

  // beak: a short dark wedge, pointed down
  const bw = mix(4.6, 5.8, g) * T.beak, by = headY + headR * 0.33
  parts.push(P(H(blend(2, ellipse(0, by, bw, bw * 0.45), seg(0, by, 0, by + bw * 0.95, bw * 0.5, bw * 0.12))), { relief: 2, tone: 0.35 }))

  // A herring crosswise in the beak, its tail flapping: lunch, or the one a penguin brings a friend.
  if (T.extra === 'herring') {
    const hy = by + bw * 0.85, flap = 0.35 * Math.sin(2 * f * t)
    const fish = blend(1.5, ellipse(-2, hy, 10, 3.3), seg(6.5, hy, 10.5, hy, 2, 1))
    const tail = turn(10.5, hy, flap)(blend(1, ellipse(12.8, hy - 2, 3.3, 1.4, -0.6), ellipse(12.8, hy + 2, 3.3, 1.4, 0.6)))
    parts.push(P(H(blend(1, fish, tail)), acc({ relief: 2.5, ink: true })))
    parts.push(P(H(circle(-8.8, hy - 0.7, 1.1)), acc({ tone: 0.1 })))
  }

  // eyes; their height is tuned so each age's pupils land on a text row in the 56-column plate
  const er = mix(6.6, 5.5, g)
  const G1 = 0.9 / 1.9 // age 1.0
  const lift = g < G1 ? mix(5.1, 4.2, g / G1) : mix(4.2, 1.75, (g - G1) / (1 - G1))
  const blink = mood === 'idle' && Math.cos(t - 1.25 * Math.PI) > 0.97 // once a loop, on the sixth frame
  for (const side of [-1, 1]) {
    const e = eye(side * headR * 0.42, headY - lift, er, blink ? 'nap' : mood, { look: [0, -0.2] })
    // The odd eye: the right one's pupil, in a colour of its own.
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    for (const p of e) parts.push({ ...p, d: X(H(p.d)) })
  }

  return { ...size, parts }
}
