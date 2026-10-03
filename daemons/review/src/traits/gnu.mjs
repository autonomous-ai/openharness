import { ellipse, circle, box, seg, tube, path, union, meet, blend, mirror, part, eye } from '../eggproto/plate.mjs'

// gnu with traits: GNU's Not Unix (Richard Stallman, 1983), the recursive acronym; the gnu is a
// wildebeest. Every hatch is its own gnu: the seed decides coat colour, markings, proportions, rare
// extras and temperament; the drawing is the same model with different inputs.
export const size = { w: 100, h: 86 }
const cx = 50

export const DEFAULT = { horns: 1, curl: 1, beard: 1, brows: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const mark = (d, o = {}) => part(d, { tone: 0.97, mat: 'marks', ink: false, ...o })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

// Long hanging hair: a vertical hatch that waves a little down its length.
const hair = (lo, dx = () => 0) => (x, y) => lo + (1 - lo) * (0.5 + 0.5 * Math.sin((x - dx(y)) * 1.5 + Math.sin(y * 0.22) * 2))

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const R = rng(T.seed * 7919)
  const fidget = T.temper === 'fidgety'
  const f = fidget ? 2 : 1, amp = fidget ? 1.35 : 1

  const chew = (mood === 'nap' ? 0 : 1) * Math.sin(2 * f * t) // a slow chew: the jaw rolls side to side, twice a loop
  const sway = amp * Math.sin(f * t + 0.6) // the beard swings
  const flick = Math.pow(Math.max(0, Math.cos(f * t - (3 * Math.PI) / 4)), 12) // one quick ear flick

  // body language
  const perk = ['need', 'boop', 'done', 'back'].includes(mood) ? 1 : ['fail', 'nap'].includes(mood) ? -1 : 0
  const lift = mood === 'done' ? -2 : mood === 'nap' ? 1.2 : 0 // a hop, a nod
  const browTilt = { work: 0.3, fail: -0.32, need: -0.12, boop: -0.12 }[mood] ?? 0 // + frowns, - worries
  const browUp = { need: -2.2, boop: -2.2, done: -1, back: -1, nap: 0.8 }[mood] ?? 0

  const parts = []
  const add = (d, o) => parts.push(part(d, o))

  const headY = 32 + lift
  const muzzleY = headY + 23
  const eyeR = 7, eyeY = headY + 7

  // shoulders, behind the head: dark, a quiet base
  const shoulders = blend(12, ellipse(cx, 106, 50, 30), ellipse(cx, 80, 18, 8))
  add(shoulders, { relief: 12, tone: 0.3 })
  // Brindled coat: the bands down the shoulders the brindled (blue) wildebeest is named for.
  if (T.marks === 'brindle') {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const x = cx + s * (15 + i * 7.2 + R() * 1.6)
        parts.push(mark(meet(seg(x, 70, x + s * 3.5, 90, 1.5, 2.1), shoulders), { tone: 0.8 }))
      }
    }
  }
  // the neck
  add(seg(cx, muzzleY - 6, cx, 90, 10.5, 14), { relief: 8, tone: 0.36 })

  // ears: out and a little down, under the horns; the left one flicks
  const droop = 0.4 - 0.34 * perk
  const ear = (side, a) => ellipse(cx + side * (16 + 9.5 * Math.cos(a)), headY - 5 + 9.5 * Math.sin(a), 9.5, 3.8, side * a)
  add(ear(-1, droop - 0.45 * flick), { relief: 2.5, tone: 0.62 })
  add(ear(1, droop), { relief: 2.5, tone: 0.62 })

  // forelock: a wild white tuft over the brow
  const tq = headY - 20
  add(union(ellipse(cx - 4, tq, 3.2, 6.5, -0.45), ellipse(cx + 1, tq - 1.5, 3.2, 7, 0.1), ellipse(cx + 5.5, tq + 1, 3, 5.5, 0.6)), { relief: 2.5, tone: 1, tex: hair(0.55) })

  // the white beard, hanging from the jaw, its lower edge in strands; it swings and follows the chew.
  // A fuller beard is broader and longer; the canvas floor stops it where the shoulders end.
  const bx = cx + chew * 0.6, top = muzzleY + 9, bottom = Math.min(85 + (85 - top) * (T.beard - 1), 88)
  const bw = 1 + (T.beard - 1) * 0.9
  const swing = (y) => sway * 2.4 * clamp01((y - top) / (bottom - top)) + chew * 0.6
  const beardBody = blend(6, ellipse(bx, top, 14.5 * bw, 5), seg(bx, top + 1, cx + sway * 2.4, bottom, 14 * bw, 3.5 * bw))
  const strands = (x, y) => y - (bottom - 4 + 3 * Math.sin((x - cx - sway * 2.4) * 1.1) - Math.abs(x - cx) * 0.3 / bw)
  add(meet(beardBody, strands), { relief: 3, tone: 1, tex: hair(0.45, swing) })

  // head: a round brow, a long face, a broad muzzle
  const head = blend(9, ellipse(cx, headY, 20, 15.5), seg(cx, headY + 6, cx, muzzleY - 2, 11.5, 9.8), ellipse(cx, muzzleY, 13.5, 8))
  add(head, { relief: 14, tone: 0.78 })
  // Blaze: a stripe down the long face, brow to nose.
  if (T.marks === 'blaze') parts.push(mark(meet(seg(cx, headY - 9, cx, muzzleY - 3, 4.2, 2.6), head), { relief: 3 }))
  // the chewing jaw
  add(ellipse(cx + chew * 1.3, muzzleY + 7, 8.5, 3), { relief: 2, tone: 0.72 })
  // a small, contented smile
  add(tube(path(cx - 4.5 + chew * 1.3, muzzleY + 6.3, 0.5, 9, () => -0.11), 0.85), { tone: 0.03, ink: false })

  // horns: one bar across the top of the head, out sideways with a slight droop, then up like
  // handlebars. The bar's length is the span; the curl is how far the tip turns, so a curlier horn
  // hooks back in rather than climbing higher. Smaller horns hook on a smaller radius.
  const hk = Math.min(1, 0.5 + 0.5 * T.horns)
  const bar = 48 * 0.42 * T.horns, hornLen = 48 * (0.42 * T.horns + 0.58 * T.curl * hk), turn = (0.12 + 0.012 * (T.curl - 1)) / hk
  const hornPts = path(cx, headY - 13.5, Math.PI - 0.12, hornLen, (u) => (u * hornLen < bar ? 0 : turn))
  const horn = mirror(cx, tube(hornPts, 5.4, Math.min(1.1, Math.max(0.9, 1.1 + 4.3 * (1 - hornLen / 48)))))
  add(horn, { relief: 3.5, tone: 1 })
  // Ringed horns: the ridges a bovid's horns grow in, darker bands along the handlebar.
  if (T.marks === 'ringed') {
    for (let k = 3; k <= 19; k += 4) {
      const [ax, ay] = hornPts[k], [bx2, by2] = hornPts[k + 1], l = Math.hypot(bx2 - ax, by2 - ay), nx = -(by2 - ay) / l, ny = (bx2 - ax) / l
      parts.push(mark(meet(mirror(cx, seg(ax - nx * 7, ay - ny * 7, ax + nx * 7, ay + ny * 7, 0.95)), horn), { tone: 0.4 }))
    }
  }

  // bushy white eyebrows: the professor's; some grow them wilder than others
  for (const s of [-1, 1]) {
    const heading = s < 0 ? Math.PI + 0.32 + browTilt : -0.32 - browTilt
    add(tube(path(cx + s * 3.5, headY - 4.5 + browUp, heading, 13 * T.brows, () => s * 0.075), 2.9 * T.brows, 1.5 * T.brows), { tone: 1 })
  }

  // snout and nostrils
  const snout = ellipse(cx, muzzleY + 1.5, 11.5, 5.8)
  add(snout, { relief: 4, tone: 0.95 })
  // Freckles across the nose.
  if (T.marks === 'freckles') {
    for (const s of [-1, 1]) for (const [dx, dy] of [[3.4, -3.4], [7.6, -2.6], [5.2, 0.2]]) parts.push(mark(circle(cx + s * dx, muzzleY + dy, 1.55), { tone: 0.3 }))
  }
  for (const s of [-1, 1]) add(ellipse(cx + s * 5.2, muzzleY + 2.8, 2.9, 2, s * 0.55), { tone: 0.03, ink: false })

  // eyes, looking a little down, calm
  for (const s of [-1, 1]) {
    const e = eye(cx + s * 10.5, eyeY, eyeR, mood, { look: [-s * 0.2, 0.25] })
    if (T.oddEye && s > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    parts.push(...e)
  }

  // Rare extras.
  if (T.extra === 'glasses') {
    // round wire readers over the eyes
    const ly = eyeY + 0.6, rx = 8.6, ry = 7.6
    parts.push(acc(union(ring(cx - 10.5, ly, rx, ry, 0.8), ring(cx + 10.5, ly, rx, ry, 0.8), seg(cx - 10.5 + rx, ly - 1, cx + 10.5 - rx, ly - 1, 0.8),
      seg(cx - 10.5 - rx, ly - 1.5, cx - 20.5, eyeY - 5, 0.75), seg(cx + 10.5 + rx, ly - 1.5, cx + 20.5, eyeY - 5, 0.75))))
  }
  if (T.extra === 'mortarboard') {
    // the graduate's cap: a square board seen from a little above, the skull cap under it, a tassel
    const by = headY - 23
    const board = (x, y) => box(cx, by, 12.5, 12.5, 1, Math.PI / 4)(x, by + (y - by) / 0.34) * 0.34
    parts.push(acc(box(cx, by + 6.5, 10.5, 5, 2), { relief: 3, tone: 0.7 }))
    parts.push(acc(board, { relief: 2.5 }))
    const tw = 1.6 * Math.sin(f * t) * amp
    const cord = [[cx, by], [cx + 9, by + 0.6], [cx + 17.2, by]]
    for (let k = 1; k <= 8; k++) cord.push([cx + 17.2 + tw * (k / 8), by + k * 1.6])
    parts.push(acc(tube(cord, 0.75)))
    parts.push(acc(seg(cx + 17.2 + tw, by + 12, cx + 17.2 + tw * 1.1, by + 17, 1.3, 2), { tex: (x) => (Math.floor(x * 1.2) % 2 ? 1 : 0.7) }))
    parts.push(acc(circle(cx, by, 1.6)))
  }
  if (T.extra === 'bowtie') {
    // a proper bow tie under the chin, on the beard
    const y = muzzleY + 12.5, x = bx
    parts.push(acc(union(seg(x, y, x - 9.5, y - 0.8, 1.4, 4.6), seg(x, y, x + 9.5, y - 0.8, 1.4, 4.6)), { relief: 2.5, ink: true }))
    parts.push(acc(ellipse(x, y, 2.4, 2.8), { relief: 2, tone: 0.8 }))
  }
  return { ...size, parts }
}

// The traits a hatch rolls. Coats follow the real wildebeest: the savanna gnu of the roster, the blue
// (brindled) gnu, the black (white-tailed) gnu, a dusty tawny, a Mara-river dusk, and the rare golden
// morph. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['savanna', 30], ['blue', 22], ['black', 17], ['tawny', 14], ['dusk', 11], ['golden', 6]]
export const MARKS = [[null, 35], ['brindle', 25], ['blaze', 18], ['ringed', 13], ['freckles', 9]]
export const EXTRAS = [['glasses', 5], ['mortarboard', 4], ['bowtie', 3], [null, 88]]
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = (lo, hi) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    horns: between(0.8, 1.2), curl: between(0.7, 1.35), beard: between(0.72, 1.28), brows: between(0.75, 1.25),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue every species exports: colour families [name, weight, top, bottom], markings, extras
// [name, weight, colour], proportion ranges, and the accent colours markings are painted in.
export const TRAITS = {
  colours: [['savanna', 30, '#ffffd7', '#afaf87'], ['blue', 22, '#d7d7ff', '#5f87af'], ['black', 17, '#d0d0d0', '#585858'],
    ['tawny', 14, '#ffd7af', '#af875f'], ['dusk', 11, '#ffd7ff', '#875f87'], ['golden', 6, '#ffd75f', '#d78700']],
  marks: MARKS,
  extras: [['glasses', 5, '#d7af5f'], ['mortarboard', 4, '#8787d7'], ['bowtie', 3, '#ff5f5f'], [null, 88, null]],
  props: { horns: [0.8, 1.2], curl: [0.7, 1.35], beard: [0.72, 1.28], brows: [0.75, 1.25] },
  accents: ['#ffaf5f', '#87d7ff', '#d7ff87', '#ff87af', '#ffffff'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['gnu', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.horns, P.horns) && '--long-horns', near(tr.curl, P.curl) && '--curly', near(tr.beard, P.beard) && '--full-beard', near(tr.brows, P.brows) && '--bushy-brows',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
