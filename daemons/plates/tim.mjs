import { ellipse, circle, tube, path, blend, seg, meet, union, part, eye, rng, headroom } from '../tools/plate.mjs'

// tim, the octopus: tmux improved, the way vim is vi improved. Eight arms, eight panes. It will do
// git's octopus merge too, which takes more than two branches at once.
//
// Every hatch is its own tim: the seed decides its colour, markings, proportions, rare extra and
// temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 114, h: 96 }

// One arm per row: where it leaves the body (x from the middle, y), its heading (0 = right,
// PI/2 = down, left side), its length, the curl in its last stretch (positive turns up and out),
// how much it waves, and its phase.
const ARMS = [
  { x: -22, y: 43, a: Math.PI + 0.35, len: 32, curl: 9, wave: 0.4, ph: 0.0 },
  { x: -16, y: 49, a: 2.3, len: 44, curl: -4.6, wave: 0.6, ph: 1.4 },
  { x: -9, y: 53, a: 1.95, len: 40, curl: 4.4, wave: 1.2, ph: 2.3 },
  { x: -3, y: 54, a: 1.66, len: 38, curl: -4.8, wave: 1.4, ph: 3.1 },
]

// Growth: a hatchling is mostly head with stubby arms; each version is drawn smaller and set on
// the same floor.
const AGES = { '0.1': { s: 0.56, arm: 0.42 }, '1.0': { s: 0.8, arm: 0.72 }, '2.0': { s: 1, arm: 1 } }

// Mood body language: the top arms go up for joy and alarm, everything droops on a failure.
const LIFT = { done: -0.35, back: -0.35, need: -0.5, boop: -0.3, fail: 0.4, nap: 0.2 }

// The traits that draw today's tim: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { head: 1, arms: 1, curl: 1, eyes: 1, gap: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// An individual gets two portrait rows of headroom (four at 56 columns), for a beanie's pompom.
const ROOM = 2

const mark = (d) => part(d, { tone: 0.97, mat: 'marks', ink: false })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const g = AGES[age] ?? AGES['2.0']
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  // A fidgety tim waves twice as fast and further (whole multiples of t, so every loop still loops).
  const fidget = T.temper === 'fidgety'
  const ft = fidget ? 2 * t : t, amp = fidget ? 1.6 : 1
  const cx = 57, lift = LIFT[mood] ?? 0
  const back = [], front = [], stripes = []
  const tip = 0.7 + (1 - g.arm) * 1.6
  for (const side of [-1, 1]) {
    for (const [i, arm] of ARMS.entries()) {
      const sway = amp * Math.sin(ft + arm.ph + (side > 0 ? 1.1 : 0))
      const a = arm.a + (i === 0 ? lift : lift * 0.35)
      const heading = side < 0 ? a : Math.PI - a
      const s = side < 0 ? 1 : -1
      // a gentle S along the arm, then a tight spiral at the tip
      const bend = (u) => s * (arm.wave * 0.06 * Math.sin(u * Math.PI * 2 + sway) + (arm.curl * T.curl * 0.05 * Math.pow(Math.max(0, u - 0.45) / 0.55, 2) * (1 + 0.25 * sway)) / g.arm)
      const pts = path(cx - side * arm.x * T.head, arm.y + (T.head - 1) * 8, heading + s * 0.08 * sway, arm.len * g.arm * T.arms, bend)
      ;(i < 2 ? back : front).push(part(tube(pts, 4.2, tip), { relief: 3.5, tone: 0.86 }))
      // Striped arms: a band across the arm every few steps, a little proud of it.
      if (T.marks === 'stripes') {
        for (let k = 3; k < pts.length - 4; k += 5) {
          const u = k / pts.length
          stripes.push(mark(tube(pts.slice(k, k + 3), 4.3 * (1 - u) + 0.75 + (tip - 0.7) * u)))
        }
      }
    }
  }
  const breath = 1 + 0.025 * Math.sin(t)
  const hy = 21, hr = 29 * T.head, hv = 22 * T.head
  const head = blend(10, ellipse(cx, hy, hr * breath, hv * breath), ellipse(cx, 40, 21 * T.head, 10))
  const parts = [...back, ...front.reverse(), part(head, { relief: 8, tone: 0.8 })]

  // Markings on the head (spots, patches), the arms (stripes) and the cheeks (freckles).
  if (T.marks === 'spots') {
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * (0.15 + 0.7 * R()), d = 0.35 + 0.5 * R()
      parts.push(mark(meet(circle(cx + Math.cos(a) * hr * d, hy + Math.sin(a) * hv * d, 1.8 + 2.2 * R()), head)))
    }
  }
  if (T.marks === 'patches') {
    parts.push(mark(meet(ellipse(cx - hr * 0.45, hy - hv * 0.35, hr * 0.42, hv * 0.34, 0.5), head)))
    parts.push(mark(meet(ellipse(cx + hr * 0.55, hy - hv * 0.05, hr * 0.28, hv * 0.26, -0.4), head)))
  }
  parts.push(...stripes)
  const ey = 39 + (T.head - 1) * 6, gap = 12 * T.gap * T.head, er = 9.5 * T.eyes
  if (T.marks === 'freckles') { // three dots under each eye, big enough to take their cells' colour
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) parts.push(mark(circle(cx + side * (gap + 3 + i * 3.2), ey + er * 0.9 + (i === 1 ? 2 : 0), 1.5)))
  }
  for (const side of [-1, 1]) {
    const e = eye(cx + side * gap, ey, er, mood, { look: [-side, 0.3] })
    // The odd eye: the right one's pupil, in a colour of its own.
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    parts.push(...e)
  }

  // Rare extras.
  if (T.extra === 'glasses') { // round reading glasses, for all that scrollback
    const rr = er * 1.18
    parts.push(acc(union(ring(cx - gap, ey, rr * 1.12, rr, 0.95), ring(cx + gap, ey, rr * 1.12, rr, 0.95), seg(cx - gap + rr * 1.1, ey - 1, cx + gap - rr * 1.1, ey - 1, 0.9),
      seg(cx - gap - rr * 1.12, ey - 1, cx - hr * 0.98, ey - 5, 0.8), seg(cx + gap + rr * 1.12, ey - 1, cx + hr * 0.98, ey - 5, 0.8))))
  }
  if (T.extra === 'beanie') { // a ribbed beanie with a pompom that bobs
    const top = hy - hv
    const cap = meet(ellipse(cx, top + 12, hr * 0.86, hv * 0.72), (x, y) => y - (top + 10))
    parts.push(acc(cap, { relief: 5, tex: (x) => (Math.floor(x / 3) % 2 ? 1 : 0.78) }))
    parts.push(acc(meet(ellipse(cx, top + 11, hr * 0.9, 4.2), (x, y) => Math.abs(y - (top + 11)) - 3), { relief: 2 }))
    parts.push(acc(circle(cx + 2 * Math.sin(t), top - 3.5, 4.2), { relief: 3 }))
  }
  if (T.extra === 'headset') { // on call: a headband, two ear cups and a boom mic
    const band = []
    for (let k = 0; k <= 24; k++) { const a = Math.PI + (k / 24) * Math.PI; band.push([cx + Math.cos(a) * (hr + 2), hy + 4 + Math.sin(a) * (hv + 3)]) }
    parts.push(acc(tube(band, 1.4)))
    for (const side of [-1, 1]) parts.push(acc(ellipse(cx + side * (hr + 1.5), hy + 5, 4.2, 6.2), { relief: 3 }))
    parts.push(acc(tube(path(cx + hr + 1, hy + 9, 2.2, 22, () => 0.05), 1.1)))
    parts.push(acc(circle(cx + hr - 12, hy + 27, 2.2)))
  }
  const grown = g.s === 1 ? parts : parts.map((p) => scaled(p, g.s, cx, 92))
  return traits ? headroom({ ...size, parts: grown }, ROOM) : { ...size, parts: grown }
}

// A part drawn at scale s about (px, py).
function scaled(p, s, px, py) {
  const from = (x, y) => [px + (x - px) / s, py + (y - py) / s]
  return { ...p, d: (x, y) => s * p.d(...from(x, y)), tex: p.tex && ((x, y) => p.tex(...from(x, y))) }
}
