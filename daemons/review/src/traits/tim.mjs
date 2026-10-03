import { ellipse, circle, tube, path, blend, part, eye, seg, meet, union } from '../eggproto/plate.mjs'

// tim with traits: every hatch is its own octopus. The seed decides colour, markings, proportions,
// rare extras and temperament; the drawing is the same model with different inputs.
export const size = { w: 124, h: 106 }
const CX = 62, DY = 10

const ARMS = [
  { x: -22, y: 43, a: Math.PI + 0.35, len: 32, curl: 9, wave: 0.4, ph: 0.0 },
  { x: -16, y: 49, a: 2.3, len: 44, curl: -4.6, wave: 0.6, ph: 1.4 },
  { x: -9, y: 53, a: 1.95, len: 40, curl: 4.4, wave: 1.2, ph: 2.3 },
  { x: -3, y: 54, a: 1.66, len: 38, curl: -4.8, wave: 1.4, ph: 3.1 },
]

export const DEFAULT = { head: 1, arms: 1, curl: 1, eyes: 1, gap: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const mark = (d) => part(d, { tone: 0.97, mat: 'marks', ink: false })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const R = rng(T.seed * 7919)
  const fidget = T.temper === 'fidgety'
  const back = [], front = [], stripes = []
  for (const side of [-1, 1]) {
    for (const [i, arm] of ARMS.entries()) {
      const phase = fidget ? 2 * t : t
      const sway = (fidget ? 1.35 : 0.8) * Math.sin(phase + arm.ph + (side > 0 ? 1.1 : 0))
      const heading = side < 0 ? arm.a : Math.PI - arm.a
      const s = side < 0 ? 1 : -1
      const bend = (u) => s * (arm.wave * 0.06 * Math.sin(u * Math.PI * 2 + sway) + arm.curl * T.curl * 0.05 * Math.pow(Math.max(0, u - 0.45) / 0.55, 2) * (1 + 0.25 * sway))
      const pts = path(CX - side * arm.x * T.head, arm.y + DY + (T.head - 1) * 8, heading + s * 0.08 * sway, arm.len * T.arms, bend)
      ;(i < 2 ? back : front).push(part(tube(pts, 4.2, 0.7), { relief: 3.5, tone: 0.86 }))
      // Striped arms: bands across the arm, every few steps.
      if (T.marks === 'stripes') {
        for (let k = 3; k < pts.length - 4; k += 5) stripes.push(mark(tube(pts.slice(k, k + 3), 4.3 * (1 - k / pts.length) + 0.75)))
      }
    }
  }
  const breath = 1 + 0.025 * Math.sin(t)
  const hy = 21 + DY, hr = 29 * T.head, hv = 22 * T.head
  const head = blend(10, ellipse(CX, hy, hr * breath, hv * breath), ellipse(CX, 40 + DY, 21 * T.head, 10))
  const parts = [...back, ...front.reverse(), part(head, { relief: 8, tone: 0.8 })]
  // Markings on the head.
  if (T.marks === 'spots') {
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * (0.15 + 0.7 * R()), d = 0.35 + 0.5 * R()
      parts.push(mark(meet(circle(CX + Math.cos(a) * hr * d, hy + Math.sin(a) * hv * d, 1.8 + 2.2 * R()), head)))
    }
  }
  if (T.marks === 'patches') {
    parts.push(mark(meet(ellipse(CX - hr * 0.45, hy - hv * 0.35, hr * 0.42, hv * 0.34, 0.5), head)))
    parts.push(mark(meet(ellipse(CX + hr * 0.55, hy - hv * 0.05, hr * 0.28, hv * 0.26, -0.4), head)))
  }
  parts.push(...stripes)
  const ey = 39 + DY + (T.head - 1) * 6, gap = 12 * T.gap * T.head, er = 9.5 * T.eyes
  if (T.marks === 'freckles') {
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) parts.push(mark(circle(CX + side * (gap + 3 + i * 3.2), ey + er * 0.9 + (i === 1 ? 2 : 0), 1.2)))
  }
  for (const side of [-1, 1]) {
    const e = eye(CX + side * gap, ey, er, mood, { look: [-side, 0.3] })
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    parts.push(...e)
  }
  // Rare extras.
  if (T.extra === 'glasses') {
    const rr = er * 1.18
    parts.push(acc(union(ring(CX - gap, ey, rr * 1.12, rr, 0.95), ring(CX + gap, ey, rr * 1.12, rr, 0.95), seg(CX - gap + rr * 1.1, ey - 1, CX + gap - rr * 1.1, ey - 1, 0.9),
      seg(CX - gap - rr * 1.12, ey - 1, CX - hr * 0.98, ey - 5, 0.8), seg(CX + gap + rr * 1.12, ey - 1, CX + hr * 0.98, ey - 5, 0.8))))
  }
  if (T.extra === 'beanie') {
    const top = hy - hv
    const cap = meet(ellipse(CX, top + 12, hr * 0.86, hv * 0.72), (x, y) => y - (top + 10))
    parts.push(acc(cap, { relief: 5, tex: (x) => (Math.floor(x / 3) % 2 ? 1 : 0.78) }))
    parts.push(acc(meet(ellipse(CX, top + 11, hr * 0.9, 4.2), (x, y) => Math.abs(y - (top + 11)) - 3), { relief: 2 }))
    parts.push(acc(circle(CX + 2 * Math.sin(t), top - 3.5, 4.2), { relief: 3 }))
  }
  if (T.extra === 'headset') {
    const band = []
    for (let k = 0; k <= 24; k++) { const a = Math.PI + (k / 24) * Math.PI; band.push([CX + Math.cos(a) * (hr + 2), hy + 4 + Math.sin(a) * (hv + 3)]) }
    parts.push(acc(tube(band, 1.4)))
    for (const side of [-1, 1]) parts.push(acc(ellipse(CX + side * (hr + 1.5), hy + 5, 4.2, 6.2), { relief: 3 }))
    parts.push(acc(tube(path(CX + hr + 1, hy + 9, 2.2, 22, () => 0.05), 1.1)))
    parts.push(acc(circle(CX + hr - 12, hy + 27, 2.2)))
  }
  return { ...size, parts }
}

// The traits a hatch rolls. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['magenta', 30], ['lilac', 20], ['coral', 18], ['violet', 14], ['dusk', 12], ['sunset', 6]]
export const MARKS = [[null, 35], ['spots', 22], ['stripes', 18], ['freckles', 17], ['patches', 8]]
export const EXTRAS = [['glasses', 5], ['beanie', 4], ['headset', 3], [null, 88]]
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = (lo, hi) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    head: between(0.9, 1.12), arms: between(0.85, 1.15), curl: between(0.7, 1.45), eyes: between(0.85, 1.25), gap: between(0.88, 1.12),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue every species exports: colour families [name, weight, top, bottom], markings, extras
// [name, weight, colour], proportion ranges, and the accent colours markings are painted in.
export const TRAITS = {
  colours: [['magenta', 30, '#ff87ff', '#af5fd7'], ['lilac', 20, '#d7afff', '#8787d7'], ['coral', 18, '#ffafaf', '#d75f87'],
    ['violet', 14, '#d787ff', '#5f00af'], ['dusk', 12, '#afafff', '#5f5f87'], ['sunset', 6, '#ffd7af', '#d7875f']],
  marks: MARKS,
  extras: [['glasses', 5, '#e4e4e4'], ['beanie', 4, '#ffd75f'], ['headset', 3, '#87afd7'], [null, 88, null]],
  props: { head: [0.9, 1.12], arms: [0.85, 1.15], curl: [0.7, 1.45], eyes: [0.85, 1.25], gap: [0.88, 1.12] },
  accents: ['#ffffd7', '#afffff', '#ffd75f', '#d7ffaf', '#ffafd7'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['tim', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.head, P.head) && '--big-head', near(tr.arms, P.arms) && '--long-arms', near(tr.curl, P.curl) && '--curly', near(tr.eyes, P.eyes) && '--wide-eyes',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
