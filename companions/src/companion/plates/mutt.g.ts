// Generated from daemons/plates/mutt.mjs by daemons/tools/generate.mjs. Do not edit.
// @ts-nocheck
import { ellipse, circle, box, seg, tube, path, blend, meet, union, part, eye, rng } from './plate.g.js'

// mutt: the terminal mail client (Michael Elkins, 1995): "All mail clients suck. This one just sucks less."
//
// Every hatch is its own scruffy dog: the seed decides its coat, markings, proportions, rare extra
// and temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 100, h: 84 }

const FLOOR = 82

// The traits that draw today's mutt: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { head: 1, flop: 1, tail: 1, scruff: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// Move a part by a map from canvas to model coordinates, scaling its distance by k.
function warp(p, map, k = 1) {
  const q = { ...p, d: (x, y) => k * p.d(...map(x, y)) }
  if (p.relief) q.relief = p.relief * k
  if (p.tex) q.tex = (x, y) => p.tex(...map(x, y))
  return q
}
const grow = (p, s, ox, oy) => (s === 1 ? p : warp(p, (x, y) => [ox + (x - ox) / s, oy + (y - oy) / s], s))
const shift = (p, dx, dy) => (!dx && !dy ? p : warp(p, (x, y) => [x - dx, y - dy]))
const turn = (p, a, ox, oy) => {
  if (!a) return p
  const c = Math.cos(a), s = Math.sin(a)
  return warp(p, (x, y) => [ox + (x - ox) * c + (y - oy) * s, oy - (x - ox) * s + (y - oy) * c])
}

// Scruff: pointed tufts pushed out of a shape's edge, n to a full turn, only between angles lo..hi.
function tufts(d, cx, cy, n, amp, lo, hi, ph = 0) {
  return (x, y) => {
    const ang = Math.atan2(y - cy, x - cx)
    const m = Math.min(ang - lo, hi - ang)
    if (m <= 0) return d(x, y)
    const w = Math.min(1, m / 0.35)
    return d(x, y) - amp * w * (1 - Math.abs(Math.sin((ang * n) / 2 + ph))) ** 2
  }
}

// Fur that is never quite combed, shaggier on the tail, and the fringe hanging in a hatch.
const fur = (x, y) => 0.93 + 0.07 * Math.sin(x * 1.3 + Math.sin(y * 0.3) * 2.4)
const shag = (x, y) => 0.84 + 0.16 * Math.sin(x * 1.4 + Math.sin(y * 0.25) * 2)
const hair = (x, y) => 0.78 + 0.22 * Math.sin(x * 1.3 + Math.sin(y * 0.2) * 2)

const mark = (d) => part(d, { tone: 0.97, mat: 'marks', ink: false })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
// A triangle, its corners in either order: the most outside of its three edges.
function tri(ax, ay, bx, by, cx, cy) {
  const sign = Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax))
  const edge = (px, py, qx, qy) => { const l = Math.hypot(qx - px, qy - py); return (x, y) => (sign * ((x - px) * (qy - py) - (y - py) * (qx - px))) / l }
  const e = [edge(ax, ay, bx, by), edge(bx, by, cx, cy), edge(cx, cy, ax, ay)]
  return (x, y) => Math.max(e[0](x, y), e[1](x, y), e[2](x, y))
}
// An envelope: the paper, and the flap's V drawn in dark over it.
function envelope(cx, cy, hw, hh, rot, tone = 1) {
  const c = Math.cos(rot), s = Math.sin(rot)
  const at = (u, v) => [cx + u * c - v * s, cy + u * s + v * c]
  const [ax, ay] = at(-hw + 1, -hh + 1), [bx, by] = at(0, 0.6), [dx, dy] = at(hw - 1, -hh + 1)
  return [acc(box(cx, cy, hw, hh, 1, rot), { tone, ink: true, relief: 2 }),
    acc(union(seg(ax, ay, bx, by, 0.85), seg(bx, by, dx, dy, 0.85)), { tone: 0.1 })]
}

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const a = Math.max(0, Math.min(1, (parseFloat(age) - 0.1) / 1.9)) // 0 hatchling .. 1 full grown
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  // A fidgety mutt runs its loop twice over: pants, wags and flicks twice as often, and wags wider.
  const fidget = T.temper === 'fidgety'
  const f = fidget ? 2 : 1
  const happy = mood === 'done' || mood === 'back' || mood === 'boop'
  const sad = mood === 'fail'
  const pant = mood === 'idle' || mood === 'need' || happy
  const breath = Math.sin(2 * f * t)
  const letter = T.extra === 'letter'

  // ---- body: sitting, the haunch round and behind, the chest and front legs forward ----
  const body = []
  const wag = (sad ? 0.08 : mood === 'nap' ? 0.05 : happy ? 0.5 : 0.36) * (fidget ? 1.3 : 1) * Math.sin(2 * f * t)
  const tail = sad
    ? path(73, 77, 0.15 - 0.6 * Math.max(0, T.tail - 1), 17 * (0.5 + 0.5 * a) * T.tail, () => 0.02) // a long tail lies flatter along the floor
    : path(71, 74, -0.45 + wag, 27 * (0.45 + 0.55 * a) * T.tail, (u) => (-0.035 - 0.04 * wag) * (0.4 + 1.6 * u))
  body.push(part(tube(tail, 5, 1.8), { relief: 3.5, tone: 0.86, tex: shag }))

  const haunch = ellipse(63, 70, 13.5, 11)
  const chest = tufts(ellipse(47, 64, 13.5 + 0.3 * breath, 14), 47, 64, 24, 2.4 * T.scruff, 0.4, 2.7)
  const trunk = blend(10, haunch, chest)
  body.push(part(trunk, { relief: 10, tone: 0.84, tex: fur }))
  // Brindle: the tiger-striped coat of half the dogs at the pound.
  if (T.marks === 'brindle') {
    const bands = (x, y) => (Math.abs(Math.sin(((x + 0.35 * (y - 64) + 1.8 * Math.sin(y * 0.28)) * Math.PI) / 9)) - 0.6) * 4
    body.push(mark(meet(bands, (x, y) => trunk(x, y) + 1.2)))
  }
  // Spots: a scatter of patches over the flank, a little of every breed.
  if (T.marks === 'spots') {
    for (const [x, y] of [[61, 63], [71, 67], [58, 73], [67, 77], [47, 70], [75, 60]]) {
      body.push(mark(meet(circle(x + 4 * (R() - 0.5), y + 4 * (R() - 0.5), 2.4 + 1.6 * R()), (px, py) => trunk(px, py) + 1)))
    }
  }
  const hind = ellipse(69, FLOOR - 2.8, 8.5, 3.3)
  body.push(part(hind, { relief: 2.5, tone: 0.88 })) // hind paw
  const low = (x, y) => FLOOR - 8.5 - y // below the ankle
  for (const [x0, x1] of [[42, 40], [53, 54]]) {
    const leg = blend(3, seg(x0, 64, x1, FLOOR - 3, 4.4, 3.9), ellipse(x1 - 1.2, FLOOR - 2.8, 5.6, 3.1))
    body.push(part(leg, { relief: 3.5, tone: 0.92, tex: fur }))
    // Socks: white paws, as if it walked through the snow to fetch the post.
    if (T.marks === 'socks') body.push(mark(meet(leg, low)))
  }
  if (T.marks === 'socks') body.push(mark(meet(hind, (x) => -x + 62)))

  // Bandana: a neckerchief, the good dog's uniform.
  if (T.extra === 'bandana') {
    const band = tube([[33, 52.5], [42, 55.5], [52, 55], [61, 51]], 2.6)
    body.push(acc(union(band, tri(35, 54, 58, 53, 46.5, 67.5)), { relief: 3, tone: 0.9, ink: true, tex: (x, y) => 0.88 + 0.12 * Math.sin(x * 1.1 + y * 0.9) }))
  }
  // Mailbag: the mail carrier's bag slung over the back, a letter sticking out of it.
  if (T.extra === 'mailbag') {
    body.push(acc(tube([[36, 55], [47, 58], [58, 59.5]], 1.3), { tone: 0.55 })) // the strap
    body.push(...envelope(67, 55, 6.5, 4.2, 0.3))
    body.push(acc(box(66, 64.5, 8.5, 6.5, 2.5), { relief: 4, tone: 0.5, ink: true }))
    body.push(acc(meet(box(66, 60.5, 8.8, 3.5, 1.5), (x, y) => y - 63.5 + 0.05 * (x - 66) ** 2), { relief: 2, tone: 0.85, ink: true })) // the flap
    body.push(acc(box(66, 63.2, 1.6, 1.4, 0.4), { tone: 0.15 })) // its buckle
  }

  // ---- head (drawn full grown, then placed) ----
  const back = [], head = []
  const flick = (fidget ? 0.3 : 0.2) * Math.max(0, Math.sin(f * t)) ** 8
  const perk = sad ? 0.15 : 0.25 + 0.75 * a // the standing ear only hints on the hatchling
  const earUp = path(62, 19, -1.2 + (1 - perk) * 0.5 + flick, 9 + 10 * perk, (u) => 0.02 + 0.1 * u * u + (u > 0.35 ? (1 - perk) * 0.4 : 0))
  back.push(part(tube(earUp, 7.5, 1.2), { relief: 3.5, tone: 0.82, tex: fur }))

  // the skull, scruffy at the cheeks, the muzzle pushed forward and a touch to the left:
  // three-quarter view
  const skull = tufts(ellipse(46, 31, 24, 18), 46, 31, 22, 2.6 * T.scruff, 0.5, 2.7, 0.8)
  const muzzle = ellipse(40, 43.5, 11, 7.5)
  const face = blend(6, skull, ellipse(41, 43, 13, 8.5))
  head.push(part(face, { relief: 11, tone: 0.9, tex: fur }))
  head.push(part(ellipse(57.5, 29.5, 9.5, 8.8, 0.3), { relief: 4, tone: 0.34, ink: false })) // the patch
  // Blaze: a white stripe from the crown down to the nose.
  if (T.marks === 'blaze') head.push(mark(seg(46.5, 14, 42.5, 38, 2.2, 3.4)))
  if (T.marks === 'spots') {
    head.push(mark(meet(circle(29 + 4 * R(), 20 + 3 * R(), 2.6 + R()), face)), mark(meet(circle(51 + 3 * R(), 41 + 2 * R(), 2.2 + R()), face)))
  }
  head.push(part(muzzle, { relief: 6, tone: 1 }))

  // the fringe: the crown's hair, tufted on top and hanging in ragged points over the brow,
  // longer as it grows (and wilder on a scruffy one)
  const crown = tufts(ellipse(46, 31, 24.5, 18.5), 46, 31, 16, (1 + 2.8 * a) * T.scruff, -2.5, -0.7, 0.3)
  const brow = 17 + 2 * a
  const hang = (x) => (2 + 5 * a) * T.scruff * (1 - Math.abs(Math.sin((x - 33) * 0.36))) ** 2
  head.push(part((x, y) => Math.max(crown(x, y), y - brow - hang(x)), { relief: 3, tone: 1, tex: hair }))

  const look = mood === 'work' ? [-1, 0.3] : [-0.2, 0.25]
  // The odd eye: the one in the patch, in a colour of its own.
  const odd = eye(57.5, 29.5, 7.6, mood, { look, tone: 0.02 })
  if (T.oddEye && odd.length > 1 && mood !== 'fail') odd[odd.length - 1] = { ...odd[odd.length - 1], mat: 'eye' }
  head.push(...eye(34, 30, 7.6, mood, { look, tone: 0.02 }), ...odd)

  if (letter) {
    // Letter: a letter held crosswise in the mouth, bobbing with each breath: the post, fetched.
    if (pant) head.push(part(ellipse(40.5, 48.5, 7, 2.6), { tone: 0.02, ink: false }))
    head.push(...envelope(40, 51 + 0.4 * breath, 12, 6.5, -0.12))
    head.push(acc(box(48.5, 47.2 + 0.4 * breath, 2, 1.8, 0.3, -0.12), { tone: 0.4 })) // its stamp
  } else if (pant) {
    const lick = 9 + 2 * breath
    head.push(part(ellipse(40.5, 48.5, 7, 2.6), { tone: 0.02, ink: false }))
    head.push(part(seg(41, 48.5, 41.5, 48.5 + lick, 4.4, 3.8), { relief: 3, tone: 1 }))
    head.push(part(seg(41.3, 50, 41.5, 47 + lick, 0.55), { tone: 0.12, ink: false }))
  } else {
    head.push(part(tube(path(33, 47.5, 0.25, 14, () => -0.035), 0.6), { tone: 0.04, ink: false }))
  }
  head.push(part(ellipse(39.5, 40.5, 6, 4), { relief: 3, tone: 0.05 })) // nose

  // the ear that flops, hanging by the cheek and widening to a round tip (longer and rounder on a floppy one)
  const droop = (sad ? 0.25 : 0) + 0.04 * breath
  const g = (0.6 + 0.4 * a) * T.flop
  head.push(part(seg(27, 16, 27 - (11 - 4 * droop) * g, 16 + (22 + 4 * droop) * g, 3.6, 5.4 * (0.75 + 0.25 * T.flop)), { relief: 3, tone: 0.5, tex: fur }))

  // ---- place: tilt the head, grow a big-headed hatchling, sit it on the floor ----
  const tilt = mood === 'need' ? -0.12 : sad ? 0.1 : mood === 'nap' ? 0.12 : 0
  const nod = mood === 'nap' ? 2.5 : sad ? 1.5 : 0
  const hk = (1.3 - 0.3 * a) * T.head // the hatchling's head is big for its body
  const place = (p) => grow(shift(turn(p, tilt, 46, 48), 0, nod), hk, 46, 50)
  const hop = mood === 'done' ? -2.4 * Math.max(0, Math.sin(2 * f * t)) : 0
  // a big head costs the body a little, so the standing ear still clears the top
  const s = (0.68 + 0.32 * a) * (T.head > 1 ? 80.5 / (32 + 48.5 * T.head) : 1)
  return { ...size, parts: [...back.map(place), ...body, ...head.map(place)].map((p) => grow(shift(p, 0, hop), s, 50, FLOOR)) }
}
