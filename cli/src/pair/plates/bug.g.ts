// Generated from daemons/plates/bug.mjs by daemons/tools/generate.mjs. Do not edit.
// @ts-nocheck
import { ellipse, circle, box, seg, tube, path, part, eye, meet, union, rng } from './plate.g.js'

// bug: the moth found in relay 70 of the Harvard Mark II on 9 September 1947, taped into the
// logbook: "First actual case of bug being found."
//
// Every hatch is its own moth: the seed decides its colour, wing markings, proportions, rare extra
// and temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself. Its plate's reveal is not twice its portrait's rows
// tall, so an individual keeps this canvas (no headroom); everything fits on the page.
export const size = { w: 120, h: 100 }

const CX = 60
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v))

// The traits that draw today's bug: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { span: 1, plumes: 1, fluff: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// A filled polygon (iq's exact polygon distance), rounded by r.
function poly(pts, r = 0) {
  return (x, y) => {
    let d = Infinity, s = 1
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[j]
      const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay
      const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey))
      d = Math.min(d, (wx - ex * h) ** 2 + (wy - ey * h) ** 2)
      const c1 = y >= ay, c2 = y < by, c3 = ex * wy > ey * wx
      if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s
    }
    return s * Math.sqrt(d) - r
  }
}

// Move a shape by mapping render space back to its rest space; k keeps distances honest.
const warp = (d, f, k = 1) => (x, y) => { const [u, v] = f(x, y); return d(u, v) * k }

// The plate's own light, so the tape can show what lies under it.
const LIGHT = (() => { const v = [-0.5, -0.62, 0.62], n = Math.hypot(...v); return v.map((c) => c / n) })()
function shade(p, x, y) {
  const s = -p.d(x, y)
  let b = p.tone
  if (p.relief) {
    const e = 0.25
    const gx = (p.d(x + e, y) - p.d(x - e, y)) / (2 * e), gy = (p.d(x, y + e) - p.d(x, y - e)) / (2 * e)
    const gl = Math.hypot(gx, gy) || 1
    const u = Math.min(s / p.relief, 1), slope = u >= 1 ? 0 : (1 - u) / Math.sqrt(Math.max(1 - (1 - u) * (1 - u), 1e-4))
    let nx = (gx / gl) * slope, ny = (gy / gl) * slope, nz = 1
    const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl
    b = p.tone * (0.46 + 0.58 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]))
  }
  if (p.tex) b *= p.tex(x, y)
  return b
}
const under = (parts, x, y) => { for (let i = parts.length - 1; i >= 0; i--) if (parts[i].d(x, y) < 0) return shade(parts[i], x, y); return -1 }

// A strip of tape: a band along `rot` through (cx, cy), with torn ends.
function tape(cx, cy, hl, hh, rot) {
  const c = Math.cos(rot), s = Math.sin(rot)
  return (x, y) => {
    const dx = x - cx, dy = y - cy, u = dx * c + dy * s, v = -dx * s + dy * c
    const torn = 1.1 * Math.sin(v * 2.3 + (u > 0 ? 1 : 4)) + 0.6 * Math.sin(v * 5.1)
    return Math.max(Math.abs(v) - hh, Math.abs(u) - hl - torn)
  }
}

// A feathery antenna along points: a vane widest past the middle, toothed like a comb.
function plume(pts, w) {
  const segs = []
  let L = 0
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], l = Math.hypot(bx - ax, by - ay)
    segs.push([ax, ay, bx - ax, by - ay, l, L])
    L += l
  }
  // a bounding circle, so points far away skip the walk along the shaft
  const [mx, my] = pts[pts.length >> 1], R = Math.max(...pts.map(([px, py]) => Math.hypot(px - mx, py - my))) + w + 1
  return (x, y) => {
    const far = Math.hypot(x - mx, y - my) - R
    if (far > 0) return far + 1
    let best = Infinity, at = 0
    for (const [ax, ay, ex, ey, l, l0] of segs) {
      const h = clamp(((x - ax) * ex + (y - ay) * ey) / (l * l))
      const d = Math.hypot(x - ax - ex * h, y - ay - ey * h)
      if (d < best) { best = d; at = (l0 + h * l) / L }
    }
    const r = w * Math.pow(Math.sin(Math.PI * Math.min(at * 0.85 + 0.08, 1)), 0.8)
    return best - r * (0.7 + 0.3 * Math.cos(at * L * 1.25)) - 0.5
  }
}

// Scale every part about (ax, ay): the younger moths are the same moth, smaller, on the same floor.
function scaled(parts, k, ax, ay) {
  if (k === 1) return parts
  const f = (x, y) => [ax + (x - ax) / k, ay + (y - ay) / k]
  return parts.map((p) => ({ ...p, d: warp(p.d, f, k), relief: p.relief && p.relief * k, tex: p.tex && ((x, y) => p.tex(...f(x, y))) }))
}

const mark = (d, o = {}) => part(d, { tone: 0.97, mat: 'marks', ink: false, ...o })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const pair = (f) => union(f(-1), f(1))

// Wing outlines as (out from the middle, down from the thorax), for the right side.
const FORE = [[6, -8], [20, -21], [36, -32], [50, -40], [52, -33], [46, -19], [36, -6], [12, 3]]
const HIND = [[6, 2], [26, 2], [39, 9], [40, 22], [31, 35], [18, 35], [9, 24]]
// Just inside the outer edges, where a speckled moth is speckled (the hindwing's edge above the tape).
const FORE_EDGE = [[48.5, -37], [49.5, -32], [44, -19.5], [35, -8]]
const HIND_EDGE = [[36.5, 9.5], [37.5, 17]]
// The point a fraction u of the way along a line of points.
function along(pts, u) {
  const lens = [0]
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const at = u * lens[lens.length - 1]
  let i = 1
  while (i < pts.length - 1 && lens[i] < at) i++
  const k = (at - lens[i - 1]) / (lens[i] - lens[i - 1] || 1)
  return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k]
}

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  // A fidgety moth flutters and twitches twice as fast (whole multiples of t), and a little harder.
  const fidget = T.temper === 'fidgety'
  const ph = fidget ? 2 * t : t
  const g = clamp((parseFloat(age) - 0.1) / 1.9)
  const lerp = (a, b) => a + (b - a) * g
  const headK = lerp(1.22, 1), wingK = lerp(0.6, 1), antK = lerp(0.6, 1), abdK = lerp(0.62, 1), thK = lerp(1.3, 1)
  const droop = lerp(0.3, 0) // a hatchling's wing buds stick out sideways, like little arms

  const pressed = mood === 'fail', still = mood === 'nap'
  // Seen from above a raised wing looks shorter: the flutter is a small squeeze of the span.
  const flap = still ? 0 : 0.5 - 0.5 * Math.cos(2 * ph)
  const spread = mood === 'done' ? 1.05 : 1
  // broad wings grow from the root; a wide spread stops at the page's edge
  const kx = Math.min(1.066, (pressed ? 1.04 : spread) * (1 - (fidget ? 0.08 : 0.055) * flap) * T.span)
  const ky = (pressed ? 0.93 : 1) * (1 - 0.02 * flap) * T.span

  const TY = 56 // the thorax, where the wings meet
  const HY = TY - 8.6 - 14 * headK

  // ---- wings: rounded triangles, patterned, a little darker than the fluffy body --------------
  const outline = (pts, side) => pts.map(([dx, dy]) => [CX + side * dx, TY + dy])
  // each wing grows (and flutters) from its root at the side of the thorax
  const cr = Math.cos(droop), sr = Math.sin(droop)
  const toRest = (x, y) => {
    const side = Math.sign(x - CX) || 1, bx = CX + side * 6, px = (x - bx) * side, py = y - TY
    return [bx + (side * (px * cr + py * sr)) / (kx * wingK), TY + (-px * sr + py * cr) / (ky * wingK)]
  }
  const wingAt = (d) => warp(d, toRest, Math.min(kx, ky) * wingK)
  const texAt = (tx) => (x, y) => tx(...toRest(x, y))
  // forewing: pale near the body, a wavy dark crossline, a kidney spot, a dusky outer band
  const foreTex = (x, y) => {
    const dx = Math.abs(x - CX), r = Math.hypot(dx, y - TY), a = Math.atan2(y - TY, dx)
    const wob = 1.8 * Math.sin(a * 8)
    let m = r > 47 + wob ? 0.72 : 1
    if (Math.abs(r - 43 - wob) < 2.2) m *= 0.55
    m *= 1 - 0.65 * Math.exp(-((dx - 31) ** 2 + ((y - TY + 16) * 1.25) ** 2) / 11)
    return m
  }
  const hindTex = (x, y) => {
    const dx = Math.abs(x - CX), r = Math.hypot(dx, y - TY)
    return r > 28 + 2 * Math.sin(Math.atan2(y - TY, dx) * 5) ? 0.78 : 1
  }
  const hindW = [-1, 1].map((side) => part(wingAt(poly(outline(HIND, side), 3)), { tone: 0.6, relief: 5, tex: texAt(hindTex) }))
  const foreW = [-1, 1].map((side) => part(wingAt(poly(outline(FORE, side), 3.5)), { tone: 0.84, relief: 8, tex: texAt(foreTex) }))
  const wings = [...hindW, ...foreW]

  // ---- markings, painted on the wings (in rest space, so they grow and flutter with them) ----
  const hindShape = pair((s) => poly(outline(HIND, s), 3)), foreShape = pair((s) => poly(outline(FORE, s), 3.5))
  // A band r0 out from the wing root, wavy with n waves of amp, on both sides.
  const band = (r0, w, n, amp) => (x, y) => { const dx = Math.abs(x - CX), dy = y - TY; return Math.abs(Math.hypot(dx, dy) - r0 - amp * Math.sin(Math.atan2(dy, dx) * n)) - w }
  const hindMarks = [], foreMarks = []
  const dark = (d) => part(wingAt(d), { tone: 0.1, ink: false })
  if (T.marks === 'eyespots') {
    // an emperor moth's four eyes: a bright ring round a dark pupil on every wing
    const spot = (dx, dy, r) => pair((s) => circle(CX + s * dx, TY + dy, r))
    hindMarks.push(mark(wingAt(meet(spot(24, 10, 5.4), hindShape))), dark(spot(24.6, 9.8, 2.3)))
    foreMarks.push(mark(wingAt(spot(31, -17, 7.2)), { relief: 3 }), dark(spot(31.8, -17.6, 3.3)))
  }
  if (T.marks === 'bands') {
    // pale crossbands, the wavy lines a moth's pattern is drawn with
    foreMarks.push(mark(wingAt(meet(band(36, 2.3, 8, 1.8), foreShape)), { tone: 0.9 }), mark(wingAt(meet(band(21, 2, 6, 1.2), foreShape)), { tone: 0.9 }))
    hindMarks.push(mark(wingAt(meet(band(19, 2.1, 5, 1.5), hindShape)), { tone: 0.85 }))
  }
  if (T.marks === 'speckles') {
    // a peppered edge: dots along the margins, in and out, a little uneven
    const dots = []
    for (let i = 0; i < 6; i++) {
      const [dx, dy] = along(FORE_EDGE, (i + 0.3 + 0.4 * R()) / 6), inset = i % 2 ? 5.5 + 1.5 * R() : 0.5 * R()
      dots.push([dx - inset, dy - inset * 0.25, 2.1 + 0.6 * R()])
    }
    for (let i = 0; i < 3; i++) {
      const a = -0.95 + 0.5 * R() + i * 0.02, r = 30 + 8 * R() // a few more further in, where the dusting thins
      dots.push([Math.cos(a) * r, Math.sin(a) * r * 0.9, 1.6 + 0.5 * R()])
    }
    const [hx, hy] = along(HIND_EDGE, 0.3 + 0.4 * R())
    dots.push([hx - R(), hy, 2 + 0.5 * R()])
    const specks = pair((s) => union(...dots.map(([dx, dy, r]) => circle(CX + s * dx, TY + dy, r))))
    foreMarks.push(mark(wingAt(meet(specks, foreShape)), { tone: 0.92 }))
    hindMarks.push(mark(wingAt(meet(specks, hindShape)), { tone: 0.85 }))
  }
  if (T.marks === 'tips') {
    // bright wingtips past the crossline, like an orange-tip
    const apex = (x, y) => { const dx = Math.abs(x - CX), dy = y - TY; return 44.5 + 1.8 * Math.sin(Math.atan2(dy, dx) * 8) - Math.hypot(dx, dy) }
    foreMarks.push(mark(wingAt(meet(apex, foreShape)), { tone: 0.95, relief: 3 }))
  }
  const wingParts = [...hindW, ...hindMarks, ...foreW, ...foreMarks]

  // ---- antennae: feathery plumes, a bright shaft in a toothed vane, arching out -------------
  const antennae = []
  for (const side of [-1, 1]) {
    const twitch = still ? 0 : (fidget ? 0.1 : 0.07) * Math.sin((side < 0 ? 3 : 2) * ph)
    const lift = mood === 'need' ? -0.06 : mood === 'boop' ? 0.25 : pressed ? 0.8 : still ? 0.6 : 0
    const heading = -Math.PI / 2 + side * (0.22 + lift + twitch)
    // a plumier vane on a slightly shorter shaft, so the tips stay on the page
    const w0 = lerp(3.4, 3.8), w = w0 * T.plumes, len = (25 - Math.max(0, w - w0) * 0.6) * antK
    const pts = path(CX + side * 4 * headK, HY - 9 * headK, heading, len, (u) => side * 0.065 * u * (pressed ? -0.3 : 1), 14)
    antennae.push(part(plume(pts, w), { tone: 0.56, relief: w }), part(tube(pts, 1.1, 0.6), { tone: 1, ink: false }))
  }

  // ---- body: fluffy and pale, a segmented abdomen, a round head -----------------------------
  const breathe = 1 + 0.03 * Math.sin(ph)
  const fur = (x, y) => 0.86 + 0.14 * Math.sin(x * 2.3 + Math.sin(y * 1.9) * 2) * Math.sin(y * 1.7 - x * 0.6)
  const abdomen = part(seg(CX, TY + 6, CX, TY + 6 + 30 * abdK, 7.5 * breathe * (1 + 0.3 * (T.fluff - 1)), 3), {
    tone: 0.95, relief: 6, tex: (x, y) => 0.84 + 0.16 * Math.cos((y - TY) * 1.05),
  })
  const fuzz = (cx, cy, rx, ry, n, amp) => {
    const e = ellipse(cx, cy, rx, ry)
    return (x, y) => e(x, y) + amp * Math.sin(Math.atan2(y - cy, x - cx) * n)
  }
  const thorax = part(fuzz(CX, TY, 11 * thK * T.fluff, 9.5 * thK * T.fluff, 18, 0.8 * T.fluff * T.fluff), { tone: 1, relief: 7, tex: fur })
  const head = part(fuzz(CX, HY - 1, 18 * headK, 13 * headK, 22, 0.5), { tone: 0.8, relief: 8 * headK })
  // it always looks toward the light, upper left
  const look = mood === 'work' ? [-0.4, 0] : [-0.25, -0.15]
  const wide = mood === 'need' || mood === 'boop'
  const eyes = [-1, 1].flatMap((side) => {
    const e = eye(CX + side * 8.5 * headK, HY, (wide ? 6.4 : 7.5) * headK, mood, { look })
    // The odd eye: the right one's pupil, in a colour of its own.
    if (T.oddEye && side > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    return e
  })

  // a dark rim where the body lies over the wings, so it stands off them
  const halo = (p, ...behind) => part((x, y) => Math.max(p.d(x, y) - 1.7, Math.min(...behind.map((b) => b.d(x, y)))), { tone: 0.1, ink: false })
  const moth = [...antennae, ...wingParts, halo(abdomen, ...wings), abdomen, halo(thorax, ...wings, abdomen), thorax, halo(head, ...antennae, ...wings, thorax), head, ...eyes]

  // ---- the tape: flat and pale, the moth pressed under it ----------------------------------
  const onTape = (x, y) => { const b = under(moth, x, y); return b < 0 ? 0.12 : 0.5 + 0.45 * b }
  const strips = [tape(CX, TY + lerp(15, 24.4), lerp(31, 54), lerp(5.4, 6.5), 0)]
  // on a failure it gets a second strip, across the wings: pressed flat, antennae and all
  if (pressed) strips.push(tape(CX, TY - lerp(3, 1.6), lerp(20, 50), lerp(5, 6.5), 0.03))
  const tapes = strips.map((d) => part(d, { tone: 1, tex: onTape }))
  // someone made sure: a second strip across the first, over the right wings
  if (T.extra === 'crosstape') tapes.push(acc(tape(CX + 33 * wingK, TY + 19 * wingK, 20 * wingK, 5.6, -1.05), { tone: 1, tex: onTape }))

  // ---- rare extras hung from the top of the page, the same size at every age --------------
  const behind = [], over = []
  if (T.extra === 'lamp') {
    // the light it is always looking at, hanging upper left: it swings, glows, and is off for a nap
    const LX = 25, sw = 0.12 * Math.sin(ph), c = Math.cos(sw), s = Math.sin(sw)
    const hang = (d) => warp(d, (x, y) => [LX + (x - LX) * c + y * s, -(x - LX) * s + y * c])
    const lit = !still && !pressed
    if (lit) behind.push(acc(hang(circle(LX, 12.6, 7.6 + 0.7 * Math.sin(3 * ph))), { tone: 0.3 }))
    over.push(acc(hang(seg(LX, 1, LX, 5, 0.8)), { tone: 0.7 }))
    over.push(acc(hang(box(LX, 6.4, 2.8, 2.2, 0.6)), { tone: 0.7, tex: (x, y) => (Math.floor(y * 1.4) % 2 ? 1 : 0.7) }))
    over.push(acc(hang(ellipse(LX, 12.6, 5.2, 5.6)), { tone: lit ? 1 : 0.45, relief: 4 }))
  }
  if (T.extra === 'relay') {
    // relay 70, panel F: a bent contact spring hanging from the top of the page, its point clicking
    const click = 0.8 * Math.sin(4 * ph)
    over.push(acc(box(106, 1.3, 4.2, 1.3, 0.6), { tone: 0.7 }))
    over.push(acc(tube([[106, 2.5], [106, 4.5], [101.5, 8], [96, 9 + click * 0.5]], 1.35, 1.15), { tone: 0.9 }))
    over.push(acc(circle(94.4, 9.6 + click, 2.7), { relief: 2.5 }))
  }

  return { ...size, parts: [...behind, ...scaled([...moth, ...tapes], lerp(0.72, 1), CX, 96), ...over] }
}
