// Generated from daemons/plates/lynx.mjs by daemons/tools/generate.mjs. Do not edit.
// @ts-nocheck
import { ellipse, circle, box, seg, tube, path, union, blend, meet, part, eye, rng, headroom } from './plate.g.js'

// lynx: Lynx, the text-mode web browser (University of Kansas, 1992), still maintained: the web with the pictures taken out.
//
// Every hatch is its own lynx: the seed decides its coat, markings, proportions, rare extra and
// temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 92, h: 78 }

const lerp = (a, b, u) => a + (b - a) * u
const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (a, b, v) => { const u = clamp01((v - a) / (b - a)); return u * u * (3 - 2 * u) }

// The traits that draw today's lynx: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { head: 1, tufts: 1, ruff: 1, tail: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// An individual gets a portrait row of headroom (two at 56 columns), for long tufts and a hop.
const ROOM = 1

const mark = (d, o = {}) => part(d, { tone: 0.97, mat: 'marks', ink: false, ...o })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w, rot = 0) => (px, py) => Math.abs(ellipse(x, y, rx, ry, rot)(px, py)) - w

// Move a part drawn in local units: scale by k about the local origin, turn by rot, then put the
// origin at (ox, oy).
function place(p, k, ox, oy, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot)
  const to = (x, y) => { const dx = x - ox, dy = y - oy; return [(dx * c + dy * s) / k, (-dx * s + dy * c) / k] }
  const q = { ...p, d: (x, y) => p.d(...to(x, y)) * k }
  if (p.relief) q.relief = p.relief * k
  if (p.tex) q.tex = (x, y) => p.tex(...to(x, y))
  return q
}

// The spotted coat: soft jittered dots on a grid darken the fur.
const hash = (i, j) => { const v = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return v - Math.floor(v) }
function spotted(cell, r, dark) {
  return (x, y) => {
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell)
    let m = Infinity
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const a = gx + i, b = gy + j
        const px = (a + 0.2 + 0.6 * hash(a, b)) * cell, py = (b + 0.2 + 0.6 * hash(b + 7, a - 3)) * cell
        m = Math.min(m, Math.hypot(x - px, (y - py) * 0.8))
      }
    }
    return 1 - (1 - dark) * smooth(r, r * 0.5, m)
  }
}

// How far along a path (0..1) the nearest point sits: for the tail's black tip.
function along(pts, x, y) {
  let best = Infinity, at = 0
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i][0] - x) ** 2 + (pts[i][1] - y) ** 2
    if (d < best) { best = d; at = i }
  }
  return at / (pts.length - 1)
}

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  // A fidgety lynx flicks its ear, tufts and tail twice as often, and further (whole multiples of
  // t, so every loop still loops).
  const fidget = T.temper === 'fidgety'
  const ph = fidget ? 2 * t : t
  const g = clamp01((parseFloat(age) - 0.1) / 1.9) // 0 hatchling .. 1 grown
  const k = lerp(0.64, 1.05, g) // overall size
  const hk = lerp(1.45, 1.02, g) * T.head // head size against the body: kittens are mostly head
  const tuftK = lerp(0.15, 1, Math.pow(g, 1.4)) // the signature, only a hint at first
  const earK = lerp(0.72, 1, g)
  const ruffK = lerp(0.3, 1, g)
  const bs = lerp(0.75, 1, g) // where markings and extras sit on a smaller body
  const young = (p) => (bs === 1 ? p : place(p, bs, 0, 0))

  const breath = Math.sin(t)
  const hop = mood === 'done' ? 2.8 * Math.pow(Math.max(0, Math.sin(2 * t)), 2) : 0
  const twitch = Math.pow(Math.max(0, Math.sin(ph)), 6) // one quick flick of the right ear per loop

  // ---- body: local units, x from the middle, the floor at y = 0 and up is negative ----
  const chestRy = lerp(9.5, 15, g) * (1 + 0.025 * breath), chestRx = lerp(11, 14, g) * (1 + 0.015 * breath)
  const chestCy = lerp(-9, -16, g)
  const spots = spotted(5.5, 2, 0.55)
  const coat = (x, y) => lerp(1, spots(x, y), smooth(5, 9, Math.abs(x)))
  const body = []

  // a stubby tail curled out from behind the right haunch, black tipped
  const tail = path(16, -3, -0.45 + (fidget ? 0.26 : 0.16) * Math.sin(ph + 1.2), lerp(10, 15, g) * T.tail, (u) => -0.05 - 0.1 * u)
  body.push(part(tube(tail, 3.4, 3.2), { relief: 3, tone: 0.84, tex: (x, y) => 1 - 0.5 * smooth(0.7, 0.85, along(tail, x, y)) }))
  const haunch = (side) => ellipse(side * lerp(11, 12.5, g), -lerp(6, 8, g), lerp(8, 9.5, g), lerp(6, 8, g))
  const trunk = blend(6, ellipse(0, chestCy, chestRx, chestRy), haunch(-1), haunch(1))
  body.push(part(trunk, { relief: 6, tone: 0.82, tex: (x, y) => coat(x, y) * (1 - 0.5 * smooth(5, 2, Math.abs(x)) * smooth(chestCy, chestCy + 8, y)) }))
  // Spots: the heavy, bold spotting of a southern lynx, over the flanks and haunches, clear of the pale front.
  if (T.marks === 'spots') {
    for (let i = 0; i < 12; i++) {
      const side = i % 2 ? 1 : -1, x = side * (10 + 10 * R()), y = -3 - 19 * R()
      body.push(mark(meet(ellipse(x * bs, y * bs, (1.9 + 1.1 * R()) * bs, (1.5 + 0.7 * R()) * bs), trunk)))
    }
  }
  const legs = union(...[-1, 1].map((side) => seg(side * 6.2, chestCy + 3, side * 7, -4, 3.7, 3.5)))
  body.push(part(legs, { relief: 3, tone: 1 }))
  const toes = (px) => (x, y) => (y > -4.6 && Math.abs(Math.abs(x - px) - 2) < 0.5 ? 0.4 : 1)
  for (const side of [-1, 1]) {
    const px = side * 7.6
    body.push(part(ellipse(px, -3.1, 5.8, 3.4), { relief: 3, tone: 0.96, tex: toes(px) }))
  }
  const legK = lerp(0.6, 1, g) // a kitten's legs are short
  // Barred: the dark bars across a lynx's forelegs.
  if (T.marks === 'barred') {
    for (const yb of [-8.2 * legK, -14.4 * legK]) body.push(mark(meet(legs, (x, y) => Math.abs(y - yb + 0.25 * Math.abs(x)) - 1.35), { relief: 1.5, tone: 1 }))
  }
  // Socks: pale forepaws and legs to the wrist.
  if (T.marks === 'socks') {
    body.push(mark(meet(legs, (x, y) => -9 * legK - y), { relief: 3, tone: 1 }))
    for (const side of [-1, 1]) body.push(mark(ellipse(side * 7.6, -3.1, 5.8, 3.4), { relief: 3, tone: 0.96, tex: toes(side * 7.6) }))
  }
  // Satchel: a browser's bag of links on the left hip, a short chain spilling from the flap, the strap over the right shoulder.
  if (T.extra === 'satchel') {
    body.push(young(acc(seg(-11.5, -12.5, 9, -29, 0.9))))
    for (const [x, y, rot] of [[-17.5, -14.2, 0.6], [-20.6, -16.2, 0.2], [-23.6, -16.4, -0.3]]) body.push(young(acc(ring(x, y, 2.2, 1.35, 0.6, rot), { tone: 1 })))
    const bag = box(-14.5, -8.8, 5.2, 4.3, 1.4)
    body.push(young(acc(bag, { relief: 2.5, tex: (x, y) => (y < -9.4 && y > -10.6 ? 0.45 : 1) })))
    body.push(young(acc(circle(-14.5, -9, 1.1), { tone: 1 })))
  }

  // ---- head: head units, the origin between the eyes ----
  const head = []
  let earOut = 0, earDrop = 0, tilt = 0, headDy = 0
  if (mood === 'fail') { earOut = 0.6; earDrop = 2.5 }
  if (mood === 'nap') { earOut = 0.3; earDrop = 1.5; headDy = 1.5 }
  if (mood === 'need') tilt = 0.13
  if (mood === 'boop') earOut = 0.18
  if (mood === 'work' || mood === 'back') earOut = -0.06

  for (const side of [-1, 1]) {
    const flick = side > 0 ? twitch : 0
    const a = -Math.PI / 2 + side * (0.2 + earOut + 0.2 * flick)
    const bx = side * 7.5, by = -9 + earDrop
    const len = 13.5 * earK - earDrop
    const ca = Math.cos(a), sa = Math.sin(a)
    const tx = bx + ca * len, ty = by + sa * len
    const up = (x, y) => (x - bx) * ca + (y - by) * sa // distance along the ear
    head.push(part(seg(bx, by, tx, ty, 5.6, 0.5), { relief: 2.5, tone: 0.84, tex: (x, y) => 1 - 0.5 * smooth(len * 0.72, len * 0.92, up(x, y)) }))
    head.push(part(seg(bx + ca * 3 - side * 0.3, by + sa * 3, bx + ca * (len - 4.5), by + sa * (len - 4.5), 3, 0.4), { tone: 0.5, ink: false }))
    // the tuft: a brush of hair standing straight off the tip
    const ta = a - side * (0.1 + (fidget ? 0.08 : 0.05) * Math.sin(2 * ph + side) + 0.3 * flick)
    const hair = (da, l, r) => tube(path(tx - ca * 1.2, ty - sa * 1.2, ta + side * da, l * tuftK * T.tufts, () => -side * 0.02), r, 0.2)
    head.push(part(union(hair(0, 8, 0.8), hair(0.4, 5, 0.6)), { tone: 0.62, ink: false }))
  }

  // the ruff: a flared beard of fur off each cheek, in points
  const ruffSide = (side) => {
    const S = (x0, y0, x1, y1, r) => seg(side * x0, y0, side * (11 + (x1 - 11) * ruffK * T.ruff), 6 + (y1 - 6) * ruffK * T.ruff, r, 0.4)
    return union(ellipse(side * 11.5, 7, 6, 5), S(12, 3, 22, 7, 3.6), S(11, 7, 20, 13.5, 3.4), S(9, 8, 15.5, 16, 3.2))
  }
  const ruff = union(ruffSide(-1), ruffSide(1))
  head.push(part(ruff, { relief: 2.5, tone: 1, tex: (x, y) => 0.9 + 0.1 * Math.sin(Math.atan2(y - 2, x) * 16) }))

  const skull = blend(6, ellipse(0, -1.5, 14, 11), ellipse(0, 4, 15, 7))
  head.push(part(skull, { relief: 6, tone: 0.84 }))
  // Stripes: the dark lines up the forehead and the bars across each cheek ruff.
  if (T.marks === 'stripes') {
    for (const x of [-4.2, 0, 4.2]) head.push(mark(meet(seg(x * 0.75, -5.4, x * 1.3, -12, 0.95, 0.7), skull)))
    for (const side of [-1, 1]) {
      head.push(mark(meet(seg(side * 10.5, 4.2, side * 20 * T.ruff, 6.5, 1.2, 0.7), ruff)))
      head.push(mark(meet(seg(side * 9.5, 8.6, side * 17 * T.ruff, 12.5, 1.1, 0.7), ruff)))
    }
  }
  if (T.marks === 'spots') {
    for (const [x, y] of [[-6, -8.5], [-1.5, -10], [3.5, -9], [7.5, -7]]) head.push(mark(meet(circle(x + R() - 0.5, y + R() - 0.5, 1.1 + 0.5 * R()), skull)))
  }
  head.push(part(blend(2, ellipse(-2.6, 7.2, 3.1, 2.4), ellipse(2.6, 7.2, 3.1, 2.4), ellipse(0, 9.2, 3.4, 2.2)), { relief: 2, tone: 1, ink: false }))
  head.push(part(seg(0, 4.2, 0, 5.9, 1.8, 0.6), { tone: 0.1, ink: false }))
  // Goggles: aviator goggles pushed up on the forehead, for surfing the web at 2400 baud.
  if (T.extra === 'goggles') {
    const gy = -9.8, gx = 5.6, gr = 4.3
    head.push(acc(meet(skull, (x, y) => Math.abs(y - gy) - 1.3)))
    for (const side of [-1, 1]) {
      head.push(acc(circle(side * gx, gy, gr), { tone: 0.42, tex: (x, y) => (Math.hypot(x - side * gx + 1.4, y - gy + 1.4) < 1.3 ? 2.3 : 1) }))
      head.push(acc(ring(side * gx, gy, gr - 0.6, gr - 0.6, 0.8), { tone: 1 }))
    }
    head.push(acc(seg(-1.5, gy - 0.3, 1.5, gy - 0.3, 0.9), { tone: 1 }))
  }

  const look = mood === 'idle' ? [0.2, 0] : [0, 0.2]
  // eye height nudged per age so the pupils land on a row at 56 columns
  const gy = 0.9 / 1.9, ey = g < gy ? lerp(0.6, -1.4, g / gy) : lerp(-1.4, -0.6, (g - gy) / (1 - gy))
  for (const side of [-1, 1]) {
    const e = eye(side * 6.7, ey, lerp(5.3, 4.8, g), mood, { look })
    // The odd eye: the right one's pupil, in a colour of its own.
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    head.push(...e)
  }
  const headCy = lerp(-27, -40, g) + headDy + 0.2 * breath
  // Collar: a red collar under the chin, its round name tag swinging (every link needs a label).
  if (T.extra === 'collar') {
    const band = []
    for (let i = 0; i <= 20; i++) { const u = i / 20; band.push([-11 + 22 * u, 9.6 + 4.2 * Math.sin(Math.PI * u)]) }
    head.push(acc(tube(band, 1.5), { relief: 1.2 }))
    const swing = 0.6 * Math.sin(ph)
    // a kitten's big head brings the tag down to its paws: it rests on the floor, never below
    const rest = Math.min(0, -headCy / hk - 3.4 - 17.6)
    head.push(acc(seg(0, 13.6, swing * 0.6, 15.4 + rest, 0.7)))
    head.push(acc(circle(swing, 17.6 + rest, 2.9), { relief: 2.5, tone: 1 }))
  }

  const local = [...body, ...head.map((p) => place(p, hk, 0, headCy, tilt))]
  const parts = local.map((p) => place(p, k, 43, 76.5 - hop))
  return traits ? headroom({ ...size, parts }, ROOM) : { ...size, parts }
}
