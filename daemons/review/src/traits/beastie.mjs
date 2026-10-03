import { circle, ellipse, box, seg, tube, path, union, cut, meet, blend, part, eye } from '../eggproto/plate.mjs'

// beastie with traits: every hatch is its own imp. The seed decides colour, markings, proportions,
// rare extras and temperament; the drawing is the same model with different inputs. Grown (2.0) only.
export const size = { w: 100, h: 86 }

const FLOOR = 84, CX = 54

export const DEFAULT = { horns: 1, curl: 1, tail: 1, ears: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// A simple polygon (convex or not), for arrowheads and fangs (iq's polygon distance).
function poly(pts) {
  return (x, y) => {
    let d = (x - pts[0][0]) ** 2 + (y - pts[0][1]) ** 2, s = 1
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[j]
      const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay
      const h = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)))
      const qx = wx - ex * h, qy = wy - ey * h
      d = Math.min(d, qx * qx + qy * qy)
      const c1 = y >= ay, c2 = y < by, c3 = ex * wy > ey * wx
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
    }
    return s * Math.sqrt(d)
  }
}

// An arrowhead whose back sits at (x, y), pointing along `a`: `len` long, its barbs `wide` apart,
// a notch cut into the back. The tail's spade and the trident's points.
function arrow(x, y, a, len, wide, notch = 0.3) {
  const c = Math.cos(a), s = Math.sin(a), px = -s, py = c
  return poly([
    [x + c * len, y + s * len],
    [x + px * wide / 2, y + py * wide / 2],
    [x + c * len * notch, y + s * len * notch],
    [x - px * wide / 2, y - py * wide / 2],
  ])
}

const mark = (d) => part(d, { tone: 0.97, mat: 'marks', ink: false })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w, rot = 0) => (px, py) => Math.abs(ellipse(x, y, rx, ry, rot)(px, py)) - w

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const fidget = T.temper === 'fidgety'
  const droop = mood === 'fail' ? 1 : mood === 'nap' ? 0.5 : 0 // ears and tail hang
  const perk = mood === 'need' || mood === 'boop' ? 1 : 0 // ears up
  const hop = mood === 'done' ? 4 : 0 // a hop for joy; the trident stays planted and the hand slides
  const lift = 0.35 * Math.sin(t) // breathing
  // the trident rises and taps the floor, twice a loop (a fidgety one drums it four times)
  const tap = 2.2 * Math.max(0, Math.sin((fidget ? 4 : 2) * t)) * (1 - droop)
  // the tail's sway, snappier at the turn; a fidgety one whips it twice as fast and wider
  const flick = (fidget ? 1.4 * (Math.sin(2 * t) + 0.45 * Math.sin(4 * t)) : Math.sin(t) + 0.45 * Math.sin(2 * t)) * (1 - 0.6 * droop)

  // ---- body plan (local units, feet on y = 0)
  const headY = -47.4 - lift, headRx = 20.5, headRy = 17.2
  const bodyY = -20 - lift * 0.8, bodyRx = 11, bodyRy = 11.5
  const hipY = bodyY + bodyRy * 0.7, shY = bodyY - bodyRy * 0.55

  const legs = [-1, 1].map((sd) => blend(2,
    seg(sd * 4.8, hipY, sd * 6, -3, 3.5, 2.7),
    seg(sd * 5, -2.4, sd * 11.5, -1.6, 2.7, 0.9)))
  const body = ellipse(0, bodyY, bodyRx, bodyRy)
  const belly = ellipse(-0.8, bodyY + bodyRy * 0.2, bodyRx * 0.6, bodyRy * 0.62)

  // ---- the tail: out behind the left hip, a dip, then up in a swoop, ending in the spade.
  // Proud (up) and limp (along the floor) curves, mixed by droop.
  const mix = (a, b) => a + (b - a) * droop
  const tailLen = 47 * T.tail * mix(1, 0.86)
  const tailPts = path(-6, hipY - 1.5, Math.PI - mix(0.7, 0.85) + 0.045 * flick, tailLen,
    (u) => mix(u < 0.3 ? 0.058 : u < 0.7 ? 0.026 : 0.07, u < 0.3 ? 0.01 : u < 0.6 ? 0.075 : 0.03) * (47 / (tailLen / T.tail)) + 0.01 * flick * u * u)
  const [tx, ty] = tailPts[tailPts.length - 1], [qx, qy] = tailPts[tailPts.length - 4]
  const tailA = Math.atan2(ty - qy, tx - qx)
  const tail = tube(tailPts, 1.8, 1.1)
  const spade = arrow(tx - Math.cos(tailA) * 1.5, ty - Math.sin(tailA) * 1.5, tailA, 12, 11)

  // ---- the trident, planted at arm's length (or, rarely, a dinner fork: fork())
  const fx = 31, top = -62.4 - tap + hop, foot = -0.4 - tap + hop // stays planted through a hop
  const prong = 10, spread = 7.6, sr = 1.3
  const sideTop = top - prong * 0.5
  const yoke = tube([[fx - spread, sideTop], [fx - spread * 0.9, top + 0.6], [fx - spread * 0.5, top + 1.8], [fx, top + 2.1], [fx + spread * 0.5, top + 1.8], [fx + spread * 0.9, top + 0.6], [fx + spread, sideTop]], sr)
  const tipL = 8, tipW = 6.8
  const trident = union(
    seg(fx, foot, fx, top, sr * 1.1, sr),
    yoke,
    seg(fx, top, fx, top - prong, sr),
    arrow(fx, top - prong + 0.5, -Math.PI / 2, tipL, tipW),
    arrow(fx - spread, sideTop + 0.5, -Math.PI / 2 - 0.1, tipL * 0.85, tipW * 0.9),
    arrow(fx + spread, sideTop + 0.5, -Math.PI / 2 + 0.1, tipL * 0.85, tipW * 0.9),
    box(fx, top + 4, sr * 1.8, 0.9))
  const fork = union(
    seg(fx, foot, fx, top + 8, sr * 1.5, sr), // the handle, wider at the floor end
    seg(fx, top + 8, fx, top + 1, sr, 3.4), // the neck flares into the head
    box(fx, top - 0.4, 7.8, 2, 1.8),
    ...[-6.6, -2.2, 2.2, 6.6].map((dx) => seg(fx + dx, top, fx + dx, top - 13, 1, 0.8)))

  // ---- arms: one to the trident, one fist on the hip
  const armR = 2.7
  const handY = -30 - tap * 0.9 - lift * 0.3
  const reach = tube([[bodyRx * 0.7, shY], [bodyRx * 0.7 + (fx - bodyRx) * 0.45, shY + 4.5], [fx - 1.5, handY + 0.5]], armR, armR * 0.85)
  const hand = circle(fx - 0.2, handY, armR * 1.3)
  const akimbo = union(
    tube([[-bodyRx * 0.7, shY], [-bodyRx - 6, shY + 5.5], [-bodyRx + 1.4, hipY - 2.5]], armR, armR * 0.85),
    circle(-bodyRx + 1.6, hipY - 2.6, armR * 1.2))

  // ---- head, ears, horns
  const earA = -0.82 - 0.25 * perk + 1.05 * droop
  const earLen = 15 * T.ears
  const ears = [-1, 1].map((sd) => {
    const bx = sd * headRx * 0.8, byy = headY - 0.5
    const a = sd > 0 ? earA : Math.PI - earA
    const at = (f) => [bx + Math.cos(a) * earLen * f, byy + Math.sin(a) * earLen * f]
    return {
      d: seg(bx, byy, ...at(1), 5.8, 0.35),
      inner: seg(...at(0.3), ...at(0.78), 2, 0.3),
    }
  })
  // horns: longer or shorter, and curled from nearly straight up to a ram's hook; the whole turn
  // stays the same when only the length changes
  const hornLen = 13.5 * T.horns
  const horns = [-1, 1].map((sd) => {
    const bx = sd * headRx * 0.46, byy = headY - headRy * 0.8
    return tube(path(bx, byy, -Math.PI / 2 + sd * 0.6, hornLen, () => -sd * 0.1 * T.curl * (13.5 / hornLen)), 4, 0.5)
  })
  const head = blend(6, ellipse(0, headY, headRx, headRy), ellipse(0, headY + headRy * 0.45, headRx * 0.72, headRy * 0.55))

  // ---- the face
  const er = 6.1, ex = 8.6, ey = headY - 2.6
  const eyes = [-1, 1].flatMap((sd) => {
    const e = eye(ex * sd, ey, er, mood, { look: [0.25, 0] })
    if (T.oddEye && sd > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    return e
  })
  const my = headY + 6.8
  const dark = (d) => part(d, { tone: 0.05, ink: false })
  const lit = (d, tone = 1) => part(d, { tone, ink: false })
  const face = []
  if (mood === 'need') face.push(dark(ellipse(0.5, my + 0.6, 2.8, 2.8)))
  else if (mood === 'fail') face.push(dark(cut(ellipse(0.5, my + 4.4, 8, 5), ellipse(0.5, my + 8.2, 9.5, 5))))
  else if (mood === 'nap') face.push(dark(cut(ellipse(0.5, my - 0.6, 5, 2.8), ellipse(0.5, my - 2.4, 5.8, 2.8))))
  else {
    const w = mood === 'work' ? 7 : 10.5
    face.push(dark(cut(ellipse(0.8, my - 1.2, w, 6.4, -0.1), ellipse(0.6, my - 8.4, w + 2.5, 6.6, -0.1))))
    if (mood === 'work') face.push(lit(ellipse(5.2, my + 1.6, 1.8, 2.2, -0.4), 0.72)) // tongue out, concentrating
    else face.push(lit(poly([[1.4, my - 1.8], [5.6, my - 2.1], [3.8, my + 2.4]]))) // one fang
  }
  // brows only when it concentrates (knitted, inner ends down) or fails (worried, inner ends up)
  const slant = mood === 'work' ? 1.2 : -1.2, bY = ey - er - 2
  const brows = mood !== 'work' && mood !== 'fail' ? [] : [-1, 1].map((sd) =>
    dark(seg(sd * (ex + 3.4), bY - slant, sd * (ex - 2.8), bY + slant, 1.1)))

  // ---- markings, painted in the individual's accent colour
  const tailMarks = [], headMarks = [], chinMarks = []
  // Ringtail: bands along the tail, every few steps.
  if (T.marks === 'ringtail') {
    for (let k = 4; k < tailPts.length - 3; k += 6) tailMarks.push(mark(tube(tailPts.slice(k, k + 2), 1.8 - 0.7 * (k / (tailPts.length - 1)) + 0.4)))
  }
  // Mask: a bandit's domino across the eyes, for a cheeky imp.
  if (T.marks === 'mask') {
    headMarks.push(mark(meet(union(ellipse(-ex, ey, er + 3.6, er * 0.85 + 2.8, 0.12), ellipse(ex, ey, er + 3.6, er * 0.85 + 2.8, -0.12), seg(-ex, ey - 1, ex, ey - 1, 3)), head)))
  }
  // Freckles: a little cluster on each cheek.
  if (T.marks === 'freckles') {
    for (const sd of [-1, 1]) for (const [dx, dy] of [[12.4, -3.8], [16.9, -3.4], [15, 0.4]]) headMarks.push(mark(circle(0.5 + sd * dx, my + dy, 1.9)))
  }
  // Goatee: the devil's pointed chin tuft, a little flick with the tail.
  if (T.marks === 'goatee') {
    const sway = 0.5 * flick
    chinMarks.push(part((x, y) => poly([[-3.4, headY + 14.4], [4.4, headY + 14.4], [1 + sway, headY + 23.6]])(x, y) - 0.6, { tone: 0.97, mat: 'marks', ink: false, relief: 1.5 }))
  }

  // ---- rare extras, painted in the extra's colour
  const flap = fidget ? 1.4 * Math.sin(2 * t) : Math.sin(t)
  const cape = [], collar = [], halo = []
  // A tiny cape, billowing out behind (to the left), and its popped collar.
  if (T.extra === 'cape') {
    const hem = -8
    const shape = (x, y) => poly([[-6, -32], [6, -32], [20 + 0.6 * flap, hem], [-24 - 2 * flap, hem + 1.4 * flap]])(x, y) - 1.2
    const wave = (x, y) => y - (hem + 1.1 * Math.sin(x * 0.7 + (fidget ? 2 * t : t)))
    cape.push(acc(meet(shape, wave), { tone: 0.76, relief: 3, tex: (x, y) => 0.84 + 0.16 * Math.cos(9 * Math.atan2(x, y + 36)) }))
    for (const sd of [-1, 1]) collar.push(acc(seg(sd * 10, -30 - lift, sd * 21.5, -37 - lift, 2.8, 1.1), { tone: 0.86, relief: 1.5 }))
  }
  // An ironic halo, a little askew, bobbing over the horns.
  if (T.extra === 'halo') {
    const hy = headY - headRy - 7.2 + 0.7 * Math.sin(fidget ? 2 * t : t)
    halo.push(acc(ring(0.6, hy, 6.2, 2.5, 0.95, -0.16), { relief: 1.2 }))
  }

  const parts = [
    part(tail, { relief: 1.8, tone: 0.84 }),
    part(spade, { relief: 3, tone: 0.96, ink: false }),
    ...tailMarks,
    T.extra === 'fork' ? acc(fork, { relief: 1.4, tone: 1, ink: true }) : part(trident, { relief: 1.4, tone: 1 }),
    ...cape,
    ...legs.map((d) => part(d, { relief: 3, tone: 0.8 })),
    part(body, { relief: 8, tone: 0.86 }),
    part(belly, { relief: 5, tone: 0.96, ink: false }),
    part(akimbo, { relief: 2.4, tone: 0.9 }),
    part(reach, { relief: 2.4, tone: 0.9 }),
    part(hand, { relief: 2.4, tone: 0.94 }),
    ...collar,
    ...ears.flatMap((e) => [part(e.d, { relief: 3, tone: 0.88 }), part(e.inner, { tone: 0.4, ink: false })]),
    ...horns.map((d) => part(d, { relief: 2.2, tone: 1, tex: (x, y) => 0.86 + 0.14 * Math.sin(y * 2.2) })),
    part(head, { relief: 12, tone: 0.95 }),
    ...headMarks, ...chinMarks,
    ...eyes, ...face, ...brows,
    ...halo,
  ]
  // place the local model on the canvas: centred, feet on the floor
  const place = (d) => (x, y) => d(x - CX, y - FLOOR + hop)
  return {
    ...size,
    parts: parts.map((p) => ({ ...p, d: place(p.d), tex: p.tex && ((x, y) => p.tex(x - CX, y - FLOOR + hop)) })),
  }
}

// The traits a hatch rolls. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['crimson', 30], ['ember', 20], ['plum', 16], ['berkeley', 14], ['ghost', 14], ['zombie', 6]]
export const MARKS = [[null, 35], ['freckles', 20], ['ringtail', 18], ['mask', 15], ['goatee', 12]]
export const EXTRAS = [['halo', 5], ['cape', 4], ['fork', 3], [null, 88]]
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = (lo, hi) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    horns: between(0.75, 1.25), curl: between(0.5, 1.5), tail: between(0.85, 1.15), ears: between(0.85, 1.15),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue every species exports: colour families [name, weight, top, bottom], markings, extras
// [name, weight, colour], proportion ranges, and the accent colours markings are painted in.
// crimson is the classic Berkeley red; berkeley its university's blue; ghost and zombie are process
// states (a detached daemon, a defunct child nobody reaped).
export const TRAITS = {
  colours: [['crimson', 30, '#ff8787', '#d70000'], ['ember', 20, '#ffaf5f', '#d75f00'], ['plum', 16, '#d787ff', '#8700af'],
    ['berkeley', 14, '#87afff', '#005fd7'], ['ghost', 14, '#eeeeee', '#8a8a8a'], ['zombie', 6, '#afd787', '#5f8700']],
  marks: MARKS,
  extras: [['halo', 5, '#ffd75f'], ['cape', 4, '#00afaf'], ['fork', 3, '#d0d0d0'], [null, 88, null]],
  props: { horns: [0.75, 1.25], curl: [0.5, 1.5], tail: [0.85, 1.15], ears: [0.85, 1.15] },
  accents: ['#ffffd7', '#ffd787', '#afffff', '#ffd7ff', '#d7ffaf'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['beastie', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.horns, P.horns) && '--long-horns', near(tr.curl, P.curl) && '--curly-horns', near(tr.tail, P.tail) && '--long-tail', near(tr.ears, P.ears) && '--big-ears',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
