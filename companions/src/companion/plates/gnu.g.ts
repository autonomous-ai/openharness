// Generated from daemons/plates/gnu.mjs by daemons/tools/generate.mjs. Do not edit.
// @ts-nocheck
import { ellipse, circle, box, seg, tube, path, union, meet, blend, mirror, part, eye, rng } from './plate.g.js'

// gnu: GNU's Not Unix (Richard Stallman, 1983), the recursive acronym; the gnu is a wildebeest.
//
// Every hatch is its own gnu: the seed decides its coat, markings, proportions, rare extra and
// temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 100, h: 86 }

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const mix = (a, b, k) => a + (b - a) * k

// The traits that draw today's gnu: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { horns: 1, curl: 1, beard: 1, brows: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

const mark = (d, o = {}) => part(d, { tone: 0.97, mat: 'marks', ink: false, ...o })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

// Long hanging hair: a vertical hatch that waves a little down its length.
const hair = (lo, dx = () => 0) => (x, y) => lo + (1 - lo) * (0.5 + 0.5 * Math.sin((x - dx(y)) * 1.5 + Math.sin(y * 0.22) * 2))

// Scale a part about a point on the floor, so a younger gnu sits smaller on the same ground.
const grow = (p, k, ox, oy) => (k === 1 ? p : {
  ...p,
  d: (x, y) => k * p.d(ox + (x - ox) / k, oy + (y - oy) / k),
  tex: p.tex && ((x, y) => p.tex(ox + (x - ox) / k, oy + (y - oy) / k)),
})

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const cx = 50
  const g = clamp01((parseFloat(age) - 0.1) / 1.9) // 0 hatchling .. 1 full grown
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  // A fidgety gnu chews, swings its beard and flicks its ear twice as often, and swings further
  // (whole multiples of t, so every loop still loops).
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

  // proportions by age: a hatchling is mostly head and eyes, on a short face and a short neck
  const headY = mix(40, 32, g) + lift
  const muzzleY = headY + mix(15, 23, g)
  const eyeR = mix(8.4, 7, g), eyeY = headY + 7
  const headR = mix(22, 20, g), headV = mix(17.5, 15.5, g)

  // shoulders, behind the head: dark, a quiet base
  const shoulders = blend(12, ellipse(cx, 106, 50, 30), ellipse(cx, 80, 18, 8))
  add(shoulders, { relief: 12, tone: 0.3 })
  // Brindled: the dark bands down the shoulders the brindled (blue) wildebeest is named for.
  if (T.marks === 'brindle') {
    for (const s of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        const x = cx + s * (15 + i * 7.2 + R() * 1.6)
        parts.push(mark(meet(seg(x, 70, x + s * 3.5, 90, 1.5, 2.1), shoulders), { tone: 0.8 }))
      }
    }
  }
  // the neck
  add(seg(cx, muzzleY - 6, cx, 90, mix(10, 10.5, g), mix(12, 14, g)), { relief: 8, tone: 0.36 })

  // ears: out and a little down, under the horns; the left one flicks
  const droop = 0.4 - 0.34 * perk
  const ear = (side, a) => ellipse(cx + side * (16 + 9.5 * Math.cos(a)), headY - 5 + 9.5 * Math.sin(a), 9.5, 3.8, side * a)
  add(ear(-1, droop - 0.45 * flick), { relief: 2.5, tone: 0.62 })
  add(ear(1, droop), { relief: 2.5, tone: 0.62 })

  // forelock: a wild white tuft over the brow
  const q = mix(0.6, 1, g), tq = headY - mix(17, 20, g)
  add(union(ellipse(cx - 4 * q, tq, 3.2 * q, 6.5 * q, -0.45), ellipse(cx + q, tq - 1.5 * q, 3.2 * q, 7 * q, 0.1), ellipse(cx + 5.5 * q, tq + q, 3 * q, 5.5 * q, 0.6)), { relief: 2.5, tone: 1, tex: hair(0.55) })

  // the white beard, hanging from the jaw, its lower edge in strands; it swings and follows the chew.
  // A fuller beard is broader and longer; the floor stops it where the shoulders end.
  const bx = cx + chew * 0.6, top = muzzleY + 9, grown = mix(top + 6, 85, g)
  const bottom = Math.min(grown + (grown - top) * (T.beard - 1), 88)
  const bw = 1 + (T.beard - 1) * 0.9
  const swing = (y) => sway * 2.4 * clamp01((y - top) / (bottom - top)) + chew * 0.6
  const beardBody = blend(6, ellipse(bx, top, mix(8, 14.5, g) * bw, 5), seg(bx, top + 1, cx + sway * 2.4, bottom, mix(6, 14, g) * bw, 3.5 * bw))
  const strands = (x, y) => y - (bottom - 4 + 3 * Math.sin((x - cx - sway * 2.4) * 1.1) - (Math.abs(x - cx) * 0.3) / bw)
  add(meet(beardBody, strands), { relief: 3, tone: 1, tex: hair(0.45, swing) })

  // head: a round brow, a long face, a broad muzzle
  const head = blend(9, ellipse(cx, headY, headR, headV), seg(cx, headY + 6, cx, muzzleY - 2, 11.5, 9.8), ellipse(cx, muzzleY, 13.5, 8))
  add(head, { relief: 14, tone: 0.78 })
  // Blaze: a pale stripe down the long face, brow to nose.
  if (T.marks === 'blaze') parts.push(mark(meet(seg(cx, headY - 9, cx, muzzleY - 3, 4.2, 2.6), head), { relief: 3 }))
  // the chewing jaw
  add(ellipse(cx + chew * 1.3, muzzleY + 7, 8.5, 3), { relief: 2, tone: 0.72 })
  // a small, contented smile
  add(tube(path(cx - 4.5 + chew * 1.3, muzzleY + 6.3, 0.5, 9, () => -0.11), 0.85), { tone: 0.03, ink: false })

  // horns: one bar across the top of the head, out sideways with a slight droop, then up like
  // handlebars. A hatchling has two nubs; they meet and lengthen as it grows. `horns` is the bar's
  // span; `curl` is how far the tip turns, so a curlier horn hooks back in rather than climbing
  // higher, and smaller horns hook on a smaller radius.
  const hk = Math.min(1, 0.5 + 0.5 * T.horns)
  const reach = 0.42 * T.horns + 0.58 * T.curl * hk // the horn's length, 1 for today's
  const hornLen = mix(9, 48, g) * reach, bar = 0.42 * T.horns
  const turn = ((0.12 + 0.012 * (T.curl - 1)) * g) / hk
  const tip0 = mix(1.6, 1.1, g), tip = Math.min(tip0, Math.max(tip0 - 0.2, tip0 + 4.3 * (1 - reach)))
  const hornA = mix(Math.PI + 1.05, Math.PI - 0.12, Math.min(1, g * 1.6))
  const hornPts = path(cx - mix(8, 0, Math.min(1, g * 1.6)), headY - mix(11.5, 13.5, g), hornA, hornLen, (u) => (u * reach < bar ? 0 : turn))
  const horn = mirror(cx, tube(hornPts, mix(3.2, 5.4, g), tip))
  add(horn, { relief: 3.5, tone: 1 })
  // Ringed: the ridges a bovid's horns grow in, darker bands along the handlebar.
  if (T.marks === 'ringed') {
    for (let k = 3; k <= 19; k += 4) {
      const [ax, ay] = hornPts[k], [bx2, by2] = hornPts[k + 1], l = Math.hypot(bx2 - ax, by2 - ay), nx = -(by2 - ay) / l, ny = (bx2 - ax) / l
      parts.push(mark(meet(mirror(cx, seg(ax - nx * 7, ay - ny * 7, ax + nx * 7, ay + ny * 7, 0.95)), horn), { tone: 0.4 }))
    }
  }

  // bushy white eyebrows: the professor's, grown in with age; some grow them wilder than others
  if (g > 0.2) {
    for (const s of [-1, 1]) {
      const heading = s < 0 ? Math.PI + 0.32 + browTilt : -0.32 - browTilt
      add(tube(path(cx + s * 3.5, headY - 4.5 + browUp, heading, mix(8, 13, g) * T.brows, () => s * 0.075), mix(1.6, 2.9, g) * T.brows, mix(1.1, 1.5, g) * T.brows), { tone: 1 })
    }
  }

  // snout and nostrils
  add(ellipse(cx, muzzleY + 1.5, 11.5, 5.8), { relief: 4, tone: 0.95 })
  // Freckles: a scatter across the nose.
  if (T.marks === 'freckles') {
    for (const s of [-1, 1]) for (const [dx, dy] of [[3.4, -3.4], [7.6, -2.6], [5.2, 0.2]]) parts.push(mark(circle(cx + s * dx, muzzleY + dy, 1.55), { tone: 0.3 }))
  }
  for (const s of [-1, 1]) add(ellipse(cx + s * 5.2, muzzleY + 2.8, 2.9, 2, s * 0.55), { tone: 0.03, ink: false })

  // eyes, looking a little down, calm
  for (const s of [-1, 1]) {
    const e = eye(cx + s * 10.5, eyeY, eyeR, mood, { look: [-s * 0.2, 0.25] })
    // The odd eye: the right one's pupil, in a colour of its own.
    if (T.oddEye && s > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    parts.push(...e)
  }

  // Rare extras.
  if (T.extra === 'glasses') { // round wire readers: the professor reads the source
    const ly = eyeY + 0.6, rx = (8.6 * eyeR) / 7, ry = (7.6 * eyeR) / 7, temple = headR + 0.5
    parts.push(acc(union(ring(cx - 10.5, ly, rx, ry, 0.8), ring(cx + 10.5, ly, rx, ry, 0.8), seg(cx - 10.5 + rx, ly - 1, cx + 10.5 - rx, ly - 1, 0.8),
      seg(cx - 10.5 - rx, ly - 1.5, cx - temple, eyeY - 5, 0.75), seg(cx + 10.5 + rx, ly - 1.5, cx + temple, eyeY - 5, 0.75))))
  }
  if (T.extra === 'mortarboard') { // the graduate's cap, seen from a little above, its tassel swinging
    const by = headY - (headV + 7.5)
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
  if (T.extra === 'bowtie') { // a proper bow tie under the chin, on the beard
    const y = muzzleY + 12.5, x = bx
    parts.push(acc(union(seg(x, y, x - 9.5, y - 0.8, 1.4, 4.6), seg(x, y, x + 9.5, y - 0.8, 1.4, 4.6)), { relief: 2.5, ink: true }))
    parts.push(acc(ellipse(x, y, 2.4, 2.8), { relief: 2, tone: 0.8 }))
  }

  const k = mix(0.8, 1, g)
  return { ...size, parts: parts.map((p) => grow(p, k, cx, size.h)) }
}
