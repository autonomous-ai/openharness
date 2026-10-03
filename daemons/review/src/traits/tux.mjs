import { circle, ellipse, seg, tube, path, cut, blend, meet, part, eye } from '../eggproto/plate.mjs'

// tux with traits: every hatch is its own penguin. The seed decides colour, markings, proportions,
// rare extras and temperament; the drawing is the same model with different inputs.
// Linus Torvalds said a penguin bit him at a zoo in Canberra; Larry Ewing drew the mascot in the GIMP in 1996.
export const size = { w: 100, h: 84 }

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

export const DEFAULT = { colour: 'ice', round: 1, flippers: 1, feet: 1, beak: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// Markings: bright ones sit on the dark hood (crest, cheeks), dark ones on the white front (speckles, chinstrap).
const mark = (tone = 0.97) => ({ tone, mat: 'marks', ink: false })
const acc = (o = {}) => ({ tone: 0.95, mat: 'acc', ink: false, ...o })

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const R = rng(T.seed * 7919)
  const M = MOODS[mood] || MOODS.idle
  const f = T.temper === 'fidgety' ? 2 : 1 // a fidgety penguin runs its loop twice over

  const breath = Math.sin(t) * (mood === 'nap' ? 2.5 : 1)
  const hop = M.hop * Math.abs(Math.sin(f * t))
  const X = place(50, 82, 1, M.sway * Math.sin(f * t), hop)
  const P = (d, o = {}, to = X) => part(to(d), o)

  // proportions: a round bird is a wider pear, the head stays put so the eyes keep their text row
  const headR = 23
  const headY = -57 + M.droop * 2
  const bodyRx = 29 * T.round, bodyRy = 28
  const bodyY = -bodyRy - 1
  const H = turn(0, headY + headR * 0.8, M.tilt + (mood === 'nap' ? 0.05 : 0.025) * Math.sin(f * t)) // the head's own tilt

  const backTone = 0.47, coatTone = 0.47, bellyTone = 0.96
  const fw = 5.6, ft = 2 // flipper root and tip radius

  const parts = []

  // body and head: one dark pear
  const body = ellipse(0, bodyY, bodyRx * (1 + 0.012 * breath), bodyRy)
  const head = H(ellipse(0, headY, headR, headR * 0.92))
  const pear = blend(14, body, head)
  parts.push(P(pear, { relief: 12, tone: backTone }))

  // the white front: one bib from the cheeks down to the belly, under a dark hood that comes to a
  // point between the eyes
  const bellyRx = 21.5 * T.round * (1 + 0.02 * breath), bellyRy = 23
  const belly = ellipse(0, bodyY + 2, bellyRx, bellyRy)
  const mask = H(cut(ellipse(0, headY + headR * 0.12, headR * 0.84, headR * 0.74), circle(0, headY - headR * 0.64, headR * 0.3)))
  parts.push(P(belly, { relief: 10, tone: bellyTone, ink: false }))
  parts.push(P(mask, { relief: 8, tone: 0.97, ink: false }))
  parts.push(P(blend(8, belly, mask), { relief: 10, tone: 0.96, ink: false }))

  // Markings. Speckles: an African penguin's belly spots, no two birds alike (placed by the seed).
  if (T.marks === 'speckles') {
    const bib = blend(8, belly, mask)
    for (let i = 0; i < 8; i++) {
      const a = Math.PI * 2 * (i / 8 + 0.1 * R()), d = 0.35 + 0.55 * R()
      parts.push(P(meet(circle(Math.cos(a) * 19 * T.round * d, bodyY + 3 + Math.sin(a) * 17 * d, 2.3 + 1.5 * R()), bib), mark(0.22)))
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

  // Rare extras. A knitted scarf round the neck, one end down the front, fringed.
  if (T.extra === 'scarf') {
    const sy = -39.5, sw = bodyRx + 2
    const wrap = meet(ellipse(0, sy, sw, 14), (x, y) => Math.abs(y - sy - 2.4 * (1 - (x / sw) ** 2)) - 3.4)
    parts.push(P(wrap, acc({ relief: 3, ink: true, tex: (x) => (Math.floor(x / 2.4) % 2 ? 1 : 0.8) })))
    const end = path(9, sy + 3, 1.42 + 0.06 * Math.sin(f * t), 19, () => -0.012)
    parts.push(P(tube(end, 3.5, 3.1), acc({ relief: 2, ink: true, tex: (x, y) => (Math.floor(y / 4) % 2 ? 1 : 0.7) })))
    const [ex, ey] = end[end.length - 1]
    for (const i of [-1.5, -0.5, 0.5, 1.5]) parts.push(P(seg(ex + i * 2, ey + 1, ex + i * 2.3, ey + 5, 0.9, 0.6), acc()))
  }
  // A bow tie: a penguin already wears the tuxedo.
  if (T.extra === 'bowtie') {
    const by = -37.5
    const bow = blend(1.2, seg(0, by, -8, by - 0.6, 1.4, 4.3), seg(0, by, 8, by - 0.6, 1.4, 4.3))
    parts.push(P(bow, acc({ relief: 2.5, ink: true })))
    parts.push(P(circle(0, by, 2.3), acc({ relief: 1.5, tone: 0.8, ink: true })))
  }

  // flippers: down its side, the tip resting on the belly; the other out to the side and up, waving
  const fx = bodyRx - 5, fy = bodyY - bodyRy * 0.42, fl = 21 * T.flippers
  // a round, long-flippered bird flung wide (boop) would reach past the frame: lift the flipper until the tip fits
  const flipper = (x, a, lift, curl) => {
    for (let i = 0; ; i++, a += lift * 0.04) {
      const pts = path(x, fy, a, fl, (u) => curl * u)
      if (i > 30 || Math.max(...pts.map(([px]) => Math.abs(px))) + ft <= 47.5) return tube(pts, fw, ft)
    }
  }
  parts.push(P(flipper(fx, M.rest, -1, M.restCurl), { relief: 3, tone: coatTone }))
  const armA = M.arm - M.swing * (f > 1 ? 1.4 : 1) * Math.sin(M.speed * f * t)
  parts.push(P(flipper(-fx, armA, 1, M.curl), { relief: 3, tone: coatTone }))

  // feet: big and flat in front, toes splayed, planted while the body rocks
  const planted = place(50, 82, 1, 0, hop)
  const fs = T.feet, fh = 0.5 + 0.5 * T.feet // big feet grow long more than tall
  for (const side of [-1, 1]) {
    const x = side * 11.5
    const toes = [-1, 0, 1].map((i) => ellipse(x + side * 1.5 + i * 5.4 * fs, -2, 3.3 * fs, 2.7 * fh, i * 0.4))
    const foot = blend(3, ellipse(x, -3.6, 8.5 * fs, 3.2 * fh), ...toes)
    parts.push(P(foot, { relief: 2, tone: 0.72 }, planted))
  }

  // beak: a short dark wedge, pointed down
  const bw = 5.8 * T.beak, by = headY + headR * 0.33
  parts.push(P(H(blend(2, ellipse(0, by, bw, bw * 0.45), seg(0, by, 0, by + bw * 0.95, bw * 0.5, bw * 0.12))), { relief: 2, tone: 0.35 }))

  // A herring crosswise in the beak, its tail flapping: lunch, or the one it is digesting.
  if (T.extra === 'herring') {
    const hy = by + bw * 0.85, flap = 0.35 * Math.sin(2 * f * t)
    const fish = blend(1.5, ellipse(-2, hy, 10, 3.3), seg(6.5, hy, 10.5, hy, 2, 1))
    const tail = turn(10.5, hy, flap)(blend(1, ellipse(12.8, hy - 2, 3.3, 1.4, -0.6), ellipse(12.8, hy + 2, 3.3, 1.4, 0.6)))
    parts.push(P(H(blend(1, fish, tail)), acc({ relief: 2.5, ink: true })))
    parts.push(P(H(circle(-8.8, hy - 0.7, 1.1)), acc({ tone: 0.1 })))
  }

  // eyes; their height is tuned so the pupils land on a text row in the 56-column plate
  const er = 5.5, lift = 1.75
  const blink = mood === 'idle' && Math.cos(t - 1.25 * Math.PI) > 0.97 // once a loop, on the sixth frame
  for (const side of [-1, 1]) {
    const e = eye(side * headR * 0.42, headY - lift, er, blink ? 'nap' : mood, { look: [0, -0.2] })
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    for (const p of e) parts.push({ ...p, d: X(H(p.d)) })
  }

  return { ...size, parts }
}

// The traits a hatch rolls. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['ice', 30], ['emperor', 20], ['midnight', 17], ['chick', 15], ['isabelline', 12], ['gold', 6]]
export const MARKS = [[null, 35], ['speckles', 22], ['chinstrap', 18], ['cheeks', 16], ['crest', 9]]
export const EXTRAS = [['scarf', 5], ['herring', 4], ['bowtie', 3], [null, 88]]
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = (lo, hi) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  const P = TRAITS.props
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    round: between(...P.round), flippers: between(...P.flippers), feet: between(...P.feet), beak: between(...P.beak),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue: colour families [name, weight, top, bottom], markings, extras [name, weight, colour],
// proportion ranges, and the accent colours markings are painted in.
// ice is the roster gradient; emperor has the yellow-orange neck over a blue-grey back; midnight is
// the night colony; chick is the grey down; isabelline is the real, rare pale-buff penguin; gold is gold.
export const TRAITS = {
  colours: [['ice', 30, '#d7ffff', '#5f87ff'], ['emperor', 20, '#ffd787', '#5f87af'], ['midnight', 17, '#87afd7', '#0000af'],
    ['chick', 15, '#e4e4e4', '#8a8a8a'], ['isabelline', 12, '#ffffd7', '#af875f'], ['gold', 6, '#ffd75f', '#af5f00']],
  marks: MARKS,
  extras: [['scarf', 5, '#ff5f5f'], ['herring', 4, '#87d7ff'], ['bowtie', 3, '#ff0087'], [null, 88, null]],
  props: { round: [0.9, 1.1], flippers: [0.88, 1.12], feet: [0.8, 1.25], beak: [0.8, 1.3] },
  accents: ['#ffd700', '#ffaf00', '#ffff87', '#ff875f', '#ffd7af'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['tux', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.round, P.round) && '--round', near(tr.flippers, P.flippers) && '--long-flippers', near(tr.feet, P.feet) && '--big-feet', near(tr.beak, P.beak) && '--big-beak',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
