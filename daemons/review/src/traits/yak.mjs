import { ellipse, circle, box, seg, tube, path, blend, union, meet, part, eye } from '../eggproto/plate.mjs'

// yak with traits: every hatch is its own yak. yacc, "Yet Another Compiler-Compiler" (Stephen
// Johnson, Bell Labs, 1975), and yak shaving, the chain of side tasks between you and your goal.
// The seed decides coat colour, markings, proportions, rare extras and temperament; the drawing is
// the same model with different inputs.
export const size = { w: 112, h: 96 }

const FLOOR = 93

export const DEFAULT = { horns: 1, shag: 1, hump: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// Long hanging hair as vertical hatch; `sway` pushes the strands sideways more the lower they hang.
const hatch = (top, sway, amp = 0.24, f = 0.8) => (x, y) => {
  const k = Math.max(0, Math.min(1, (y - top) / 18))
  return 1 - amp * k * (0.5 - 0.5 * Math.sin((x - sway * k * k) * f + Math.sin(y * 0.15) * 1.5))
}
// A soft shadow cast on a part by the shapes in front of it.
const shadow = (d, w = 3, a = 0.55) => (x, y) => 1 - a * Math.exp(-Math.max(0, d(x, y)) / w)
// A line of hair clumps hanging in points: the height at x of a hem `drop` deep every `pitch`.
const points = (x, base, drop, pitch, phase = 0) => {
  const c = Math.abs(Math.cos(((x - phase) * Math.PI) / pitch))
  return base + drop * c * c * c
}
const mul = (...fs) => (x, y) => fs.reduce((m, f) => m * f(x, y), 1)
// Light from above: the back catches it, the hanging hair falls into shade.
const fall = (x, y) => 1 - 0.12 * Math.max(0, Math.min(1, (y - 28) / 56))

// Scale by k about (ox, oy), then move by (tx, ty): a shape, or a part with its relief and texture.
const move = (k, ox, oy, tx = 0, ty = 0) => {
  const at = (f) => (x, y) => f(ox + (x - ox - tx) / k, oy + (y - oy - ty) / k)
  const shape = (d) => { const g = at(d); return (x, y) => k * g(x, y) }
  return {
    shape,
    point: (x, y) => [ox + (x - ox) * k + tx, oy + (y - oy) * k + ty],
    part: (p) => ({ ...p, d: shape(p.d), ...(p.relief && { relief: p.relief * k }), ...(p.tex && { tex: at(p.tex) }) }),
  }
}

// A mouth across the muzzle: bend > 0 smiles, bend < 0 frowns.
const mouth = (x, y, w, bend, r) => tube(path(x - w / 2, y - bend * w * 0.3, bend * 0.9, w, () => (-bend * 1.8) / w, 10), r)

// A marking splits the part it lies on in two along a region: the same relief and texture on both
// sides, so the coat keeps its hair, shading and outline and only the colour changes. The region's
// edge is made steep so the cut leaves no rim of its own.
const paint = (p, region) => region ? [
  { ...p, d: meet(p.d, (x, y) => -100 * region(x, y)) },
  { ...p, d: meet(p.d, (x, y) => 100 * region(x, y)), mat: 'marks' },
] : [p]
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
// Rotate a shape by a about (ox, oy): hanging things swing.
const turn = (d, a, ox, oy) => { const c = Math.cos(a), s = Math.sin(a); return (x, y) => d(ox + (x - ox) * c + (y - oy) * s, oy - (x - ox) * s + (y - oy) * c) }

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const R = rng(T.seed * 7919)
  const fidget = T.temper === 'fidgety'
  const ph = fidget ? 2 * t : t
  const breath = Math.sin(ph)
  const sway = (fidget ? 1.6 : 1.2) * Math.sin(ph)
  const chew = mood === 'nap' ? 0 : Math.sin(2 * ph)

  // ---- head: out front, facing us, a shaggy mop with a face peeking out of the fringe ----
  const hx = 29, hy = 34, ey = 38
  const beard = T.shag
  const shag = blend(8,
    ellipse(hx, hy, 19, 16),
    seg(hx - 13, hy + 6, hx - 12 + 0.5 * sway, hy + 6 + 22 * beard, 7, 3.5),
    seg(hx + 13, hy + 6, hx + 12 + 0.5 * sway, hy + 6 + 22 * beard, 7, 3.5),
    ellipse(hx + 0.4 * sway, hy + 8 + 18 * beard, 12, 8),
  )
  const mop = (x, y) => Math.max(shag(x, y), y - points(x, hy + 9 + 18 * beard, 5, 6, hx + 0.6 * sway))
  const face = ellipse(hx, hy + 8, 13.5, 13)
  // the fringe is the mop with a window cut for the face, its bangs hanging in points to the eyes
  const opening = (x, y) => Math.max(face(x, y), points(x, ey - 4.5, 2.2, 6.5, hx + 3.25 + 0.3 * sway) - y)
  const fringe = (x, y) => Math.max(mop(x, y), -opening(x, y))
  const earFlick = Math.pow(Math.max(0, Math.sin(ph)), 12)
  const droop = mood === 'fail' || mood === 'nap' ? 0.55 : mood === 'need' || mood === 'boop' ? -0.35 : 0
  const ears = [
    ellipse(hx - 20, hy + 3 - 2 * earFlick, 6, 2.6, 0.35 + droop - 0.5 * earFlick),
    ellipse(hx + 20, hy + 3, 6, 2.6, -0.35 - droop),
  ]
  // horns: out sideways, then up, the tips turning in; long horns keep turning, curling over
  const hornPaths = [-1, 1].map((s) => path(hx + s * 11, hy - 9, s < 0 ? Math.PI + 0.15 : -0.15, 28 * T.horns, () => s * -0.1))
  const horns = hornPaths.map((pts) => tube(pts, 4, 0.8))
  const muzzle = ellipse(hx, 50 + 0.3 * chew, 10, 6.5)
  const nostrils = [-1, 1].map((s) => ellipse(hx + s * 4 + 0.3 * chew, 50, 2.2, 1.7))
  // deadpan: a flat mouth that works side to side, chewing the cud
  const smile = mood === 'done' || mood === 'back' ? 1 : mood === 'fail' ? -0.8 : 0
  const lips = mood === 'boop' ? ellipse(hx, 54, 1.8, 1.6) : mouth(hx + 0.8 * chew, 54.2, 6.4, smile, 0.8)

  // the head droops or lifts with the mood
  const dip = { nap: 4, fail: 2.5, work: 1, need: -1.5, boop: -1 }[mood] ?? 0
  const head = move(1, hx, hy, 0, dip)
  const front = head.shape(union(mop, ...horns))

  // ---- body: hump over the shoulders, barrel, rump, and a skirt of long hair to the floor ----
  const L = 0.96 // body length
  const bx = (x) => 48 + (x - 48) * L
  const hem = 44 + 39 * T.shag
  const trunk = blend(12,
    ellipse(bx(64), 31 - 7 * (T.hump - 1), 19 * L, 17 + 10 * (T.hump - 1)),
    ellipse(bx(76), 46, 30 * L, 16 + 0.5 * breath),
    ellipse(bx(95), 47, 10.5, 13),
    box(bx(71), (44 + hem) / 2 + 1, 32 * L, (hem - 44) / 2 + 1, 8),
  )
  const coat = (x, y) => Math.max(trunk(x, y), y - points(x, hem, 5, 7, sway))
  const legs = [42, 52, 89, 99].map((x, i) => part(
    union(seg(bx(x), 70, bx(x), FLOOR - 2, 3.6, 3.4), ellipse(bx(x) - 0.6, FLOOR - 1.4, 3.9, 1.8)),
    { tone: i % 2 ? 0.4 : 0.6, relief: 2.5 },
  ))
  const swish = mood === 'back' ? 0.1 * Math.sin(2 * ph) - 0.04 : (fidget ? 0.08 : 0.05) * Math.sin(ph + 0.8)
  const tail = tube(path(bx(104), 36, 1.48 + swish, 34, () => 0.01), 1.8, 3.8)

  // the whole animal, standing on the floor; a happy bounce when done
  const all = move(1, 56, FLOOR, 0, mood === 'done' ? -2 - 1.5 * Math.cos(2 * ph) : 0)

  const coatPart = part(coat, { tone: 0.9, relief: 10, tex: mul(hatch(44, sway), fall, shadow(front)) })
  const tailPart = part(tail, { tone: 0.78, relief: 2.5, tex: hatch(48, sway, 0.3) })
  const facePart = part(face, { tone: 0.9, relief: 6 })
  const fringePart = part(fringe, { tone: 0.84, relief: 8, tex: hatch(hy - 4, sway, 0.26) })

  // ---- markings: a region on each part they colour ----
  const on = {}
  // socks: pale lower legs, and a pale switch at the end of the tail
  if (T.marks === 'socks') Object.assign(on, { legs: (x, y) => 82 - y, tail: (x, y) => 58 - y })
  // a blaze: a pale forelock, and a stripe down the face to the muzzle
  if (T.marks === 'blaze') Object.assign(on, { face: seg(hx, ey - 8, hx, ey + 9, 2.6, 4.2), fringe: ellipse(hx + 0.3 * sway, hy - 7, 6.5, 9) })
  // two-tone: the long skirt and the lower beard in a second colour, a wavy line where they meet
  if (T.marks === 'two-tone') {
    Object.assign(on, {
      coat: (x, y) => 58 + 2 * Math.sin(x * 0.35) + 1.5 * Math.sin(x * 0.13 + 1) - y,
      fringe: (x, y) => hy + 12 + 18 * (T.shag - 1) + 1.5 * Math.sin(x * 0.5) - y,
    })
  }
  // piebald: big irregular patches over the hump, the barrel and the rump, and one on the mop
  if (T.marks === 'piebald') {
    const spots = [[62, 26, 9, 7], [80, 50, 11, 8], [98, 40, 6, 9]].map(([x, y, rx, ry]) =>
      ellipse(bx(x) + 6 * (R() - 0.5), y - (x < 70 ? 8 * (T.hump - 1) : 0) + 5 * (R() - 0.5), rx * (0.8 + 0.4 * R()), ry * (0.8 + 0.4 * R()), R() - 0.5))
    Object.assign(on, { coat: union(...spots), fringe: ellipse(hx + 11, hy - 6, 7, 5.5, 0.4) })
  }

  // ---- rare extras ----
  const headAcc = []
  // a herd bell on a strap from under the beard, swinging with the walk
  if (T.extra === 'bell') {
    const top = hy + 16 + 18 * T.shag, a = (fidget ? 0.28 : 0.16) * Math.sin(ph + 0.6)
    const bell = union(circle(hx, top + 9.5, 3.4), seg(hx, top + 10, hx, top + 15, 3.4, 5.2), ellipse(hx, top + 15.5, 5.8, 1.6))
    headAcc.push(acc(turn(seg(hx, top - 4, hx, top + 7, 1.2), a, hx, top - 4), { relief: 1.5, tone: 0.7 }))
    headAcc.push(acc(turn(bell, a, hx, top - 4), { relief: 3.5 }))
    headAcc.push(acc(turn(circle(hx, top + 17.6, 1.4), 1.6 * a, hx, top - 4), { tone: 0.5 }))
  }
  // two long braids in the fringe, wound with bright wool, a bead at the end below the beard
  if (T.extra === 'braids') {
    for (const s of [-1, 1]) {
      const pts = path(hx + s * 12.5, ey - 7, Math.PI / 2 - s * 0.06, 28 + 10 * T.shag, (u) => s * 0.01 * Math.sin(ph + u * 3) * (fidget ? 2 : 1), 16)
      headAcc.push(acc(tube(pts, 1.9, 1.4), { tone: 0.85, relief: 2, tex: (x, y) => (Math.floor((y + s * x * 0.6) / 2.2) % 2 ? 1 : 0.6) }))
      for (const k of [5, 10]) headAcc.push(acc(circle(pts[k][0], pts[k][1], 2.3), { relief: 2.3 }))
      const [ex, ey2] = pts[pts.length - 1]
      headAcc.push(acc(circle(ex, ey2 + 2, 3), { relief: 3 }))
    }
  }
  // hair clippers, hung by the cord from a horn: the shave
  if (T.extra === 'clippers') {
    const pts = hornPaths[0]
    let hook = pts[0]
    for (const p of pts) if (p[0] < hook[0]) hook = p
    const [kx, ky] = [hook[0], hook[1] + 1], a = (fidget ? 0.14 : 0.08) * Math.sin(ph + 1.2)
    const cx = kx - 1.5
    const clip = union(box(cx, ky + 15, 3.6, 6.2, 2.4), box(cx, ky + 21.8, 4.2, 1.3, 0.4))
    headAcc.push(acc(turn(union(seg(kx, ky - 1, cx, ky + 9, 0.7), (x, y) => Math.abs(circle(kx, ky - 1.5, 2.9)(x, y)) - 0.8), a, kx, ky), { tone: 0.6 }))
    headAcc.push(acc(turn(clip, a, kx, ky), { relief: 3, tex: (x, y) => (y > ky + 20 ? (Math.floor(x) % 2 ? 1 : 0.55) : 1) }))
    headAcc.push(acc(turn(box(cx, ky + 12, 1.1, 1.6, 0.5), a, kx, ky), { tone: 0.3 }))
  }

  // Eyes are placed last, snapped to the cells of the 56-column plate so each pupil lands in one.
  const [lx, ly] = all.point(...head.point(hx - 7, ey)), [rx] = all.point(...head.point(hx + 7, ey))
  const gap = 2 * Math.round((rx - lx) / 2), ex = 2 * Math.round((lx + rx - gap) / 4 - 0.5) + 1
  const eyeY = 4 * Math.round((ly - 2) / 4) + 2, r = 5
  const eyes = [ex, ex + gap].flatMap((x, side) => {
    const e = eye(x, eyeY, r, mood, { look: [0, 0.1] })
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    return e
  })
  return {
    ...size,
    parts: [
      ...legs.flatMap((p) => paint(p, on.legs)).map(all.part),
      ...[...paint(coatPart, on.coat), ...paint(tailPart, on.tail)].map(all.part),
      ...[
        ...ears.map((d) => part(d, { tone: 0.7, relief: 2 })),
        ...horns.map((d) => part(d, { tone: 1, relief: 2.5 })),
        ...paint(facePart, on.face),
      ].map(head.part).map(all.part),
      ...eyes,
      ...[
        ...paint(fringePart, on.fringe),
        part(muzzle, { tone: 1, relief: 5, ink: false }),
        ...[...nostrils, lips].map((d) => part(d, { tone: 0.1, ink: false })),
        ...headAcc,
      ].map(head.part).map(all.part),
    ],
  }
}

// The traits a hatch rolls. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['russet', 30], ['soot', 20], ['bison', 16], ['snow', 14], ['frost', 14], ['golden', 6]]
export const MARKS = [[null, 34], ['blaze', 22], ['socks', 18], ['two-tone', 16], ['piebald', 10]]
export const EXTRAS = [['bell', 5], ['braids', 4], ['clippers', 3], [null, 88]]
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = (lo, hi) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    horns: between(0.8, 1.2), shag: between(0.75, 1.15), hump: between(0.8, 1.3),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue every species exports: colour families [name, weight, top, bottom], markings, extras
// [name, weight, colour], proportion ranges, and the accent colours markings are painted in.
export const TRAITS = {
  colours: [['russet', 30, '#ffd7af', '#af5f5f'], ['soot', 20, '#bcbcbc', '#444444'], ['bison', 16, '#d7875f', '#5f0000'],
    ['snow', 14, '#ffffff', '#a8a8a8'], ['frost', 14, '#d7ffff', '#5f87af'], ['golden', 6, '#ffff87', '#d7af00']],
  marks: MARKS,
  extras: [['bell', 5, '#ffd75f'], ['braids', 4, '#ff5f5f'], ['clippers', 3, '#d0d0d0'], [null, 88, null]],
  props: { horns: [0.8, 1.2], shag: [0.75, 1.15], hump: [0.8, 1.3] },
  accents: ['#ffffff', '#ffffd7', '#d7d7d7', '#af875f', '#875f5f'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
const low = (v, [lo, hi]) => v <= lo + (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['yak', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.horns, P.horns) && '--long-horns', near(tr.shag, P.shag) && '--shaggy', low(tr.shag, P.shag) && '--shorn', near(tr.hump, P.hump) && '--big-hump',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
