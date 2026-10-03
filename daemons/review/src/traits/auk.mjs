import { circle, ellipse, box, seg, tube, path, blend, union, meet, part, eye } from '../eggproto/plate.mjs'

// auk with traits: every hatch is its own great auk. The seed decides colour, markings, proportions,
// rare extras and temperament; the drawing is the same model with different inputs.
// awk (Aho, Weinberger and Kernighan, Bell Labs, 1977) and the great auk, the first bird ever called a
// penguin, extinct since 1844; awk is still in every Unix.

// The model is drawn on the old 100 by 86 canvas and set DY lower: five text rows of headroom at 56
// columns (a row is 86 / 24 units there), so a top hat fits and the plain auk renders cell for cell.
const DY = (5 * 86) / 24
export const size = { w: 100, h: 86 + DY }

const FLOOR = { x: 57, y: 76 } // where the feet meet the rock
const K = 1.05 // the grown auk, drawn a little larger than the canvas and set on the same rock
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const mix = (a, b, u) => a + (b - a) * u
const smooth = (e0, e1, v) => { const u = clamp((v - e0) / (e1 - e0)); return u * u * (3 - 2 * u) }

export const DEFAULT = { bill: 1, stout: 1, tall: 1, flipper: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// Turn a shape (or a texture) by `a` radians about (px, py), clockwise on screen (y down).
function turn(f, px, py, a) {
  if (!a) return f
  const c = Math.cos(a), s = Math.sin(a)
  return (x, y) => { const dx = x - px, dy = y - py; return f(px + c * dx + s * dy, py - s * dx + c * dy) }
}
const turnPart = (p, px, py, a) => ({ ...p, d: turn(p.d, px, py, a), tex: p.tex && turn(p.tex, px, py, a) })

// Scale a finished part by k about the floor point, raise it by `lift` (a hop) and set it DY down.
function place(p, k = 1, lift = 0) {
  const at = (f) => (x, y) => f(FLOOR.x + (x - FLOOR.x) / k, FLOOR.y + (y - DY - FLOOR.y + lift) / k)
  const d = at(p.d)
  return { ...p, d: k === 1 ? d : (x, y) => d(x, y) * k, tex: p.tex && at(p.tex), relief: p.relief && p.relief * k }
}

const mark = (d) => part(d, { tone: 0.97, mat: 'marks', ink: false })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const R = rng(T.seed * 7919)
  const fidget = T.temper === 'fidgety'
  const ft = fidget ? 2 * t : t, amp = fidget ? 1.8 : 1

  // ---- body language -------------------------------------------------------------------
  const breath = Math.sin(ft) * (mood === 'nap' ? 1.7 : 1)
  let nod = 0.028 * amp * Math.sin(ft + 0.8) // a slow, dignified bob of the bill
  let headDx = 0, headDy = -0.45 * amp * Math.sin(ft), wingUp = 0, lift = 0
  if (mood === 'work') { nod -= 0.1; headDx = -1.5 } // leans in to read the input
  if (mood === 'fail') { nod -= 0.26; headDy += 2.5; wingUp = -0.1 } // hangs its head
  if (mood === 'nap') { nod -= 0.18; headDy += 3.5; headDx = 1.5 } // sunk into its shoulders
  if (mood === 'boop') { nod += 0.14; headDx = 2 } // pulls back from the finger
  if (mood === 'need') wingUp = -2.55 // a flipper up: a question
  if (mood === 'back') wingUp = -2.3 + 0.35 * Math.sin(2 * ft) // waves hello
  if (mood === 'done') { lift = 3 * Math.max(0, Math.sin(ft)); wingUp = -0.55 } // a small hop, flippers out
  if (fidget && (mood === 'idle' || mood === 'work')) wingUp = -0.12 * Math.max(0, Math.sin(ft)) // and a flick of the flipper

  // ---- the body: one silhouette from crown to tail ---------------------------------------
  const swell = 1 + 0.025 * breath
  const bodyRy = 23 * T.tall, bodyCy = FLOOR.y - 1 - bodyRy
  const body = ellipse(58, bodyCy, 17 * T.stout * swell, bodyRy, -0.12)
  const chest = ellipse(51, bodyCy - bodyRy * 0.3, 12 * T.stout * swell, 12)
  const headR = 14
  const hx = 46 + headDx, hy = bodyCy - bodyRy - headR * 0.55 + headDy
  const pivot = [55, bodyCy - bodyRy * 0.7] // the neck
  const head = turn(circle(hx, hy, headR), pivot[0], pivot[1], nod)
  const neck = seg(57, bodyCy - bodyRy * 0.55, hx + 3, hy + headR * 0.4, 10, 8.5)
  const tail = seg(67 + (T.stout - 1) * 12, FLOOR.y - 8, 80, FLOOR.y - 1.5, 3.8, 0.8)
  const silhouette = blend(8, body, chest, neck, head, tail)

  // White from the throat down, ending in a point on the foreneck; the rest black as a dinner jacket.
  const belly = ellipse(50.5, bodyCy + bodyRy * 0.12, 14.5 * T.stout, bodyRy * 1.08, -0.1)
  const dark = 0.56, white = 0.95
  const plumage = (x, y) => mix(dark, white, smooth(0.8, -0.8, belly(x, y)))

  // Flipper: small, held at the side, pointing down and back.
  const shoulder = [63 + (T.stout - 1) * 12, bodyCy - bodyRy * 0.5]
  const flipper = tube(path(shoulder[0], shoulder[1], 1.42, 27 * T.flipper, (u) => 0.012 + 0.02 * u), 5.4, 1.1)
  const wing = turn(flipper, shoulder[0], shoulder[1], wingUp)
  // The white bar along its trailing edge, from the tips of the secondaries.
  const bar = turn((x, y) => Math.max(flipper(x, y), -flipper(x + 1.5, y), shoulder[1] + 6 - y), shoulder[0], shoulder[1], wingUp)

  // Feet: black, webbed, flat on the rock, toes forward.
  const foot = (dx) => blend(2, seg(63 + dx, FLOOR.y - 4, 62 + dx, FLOOR.y - 1.2, 2.4, 2), seg(62 + dx, FLOOR.y - 1.2, 48 + dx, FLOOR.y - 0.8, 2, 1.1))

  // ---- the head: the deep, grooved, hooked bill and the white oval ------------------------
  // The bill is drawn level, facing left from its gape (bx, by), then tipped down a little.
  const bx = hx - headR * 0.8, by = hy + headR * 0.3
  const L = 19 * T.bill, up = 10.5 * (1 + (T.bill - 1) * 0.7), lo = 5.5 * (1 + (T.bill - 1) * 0.7), tilt = -0.08
  // The culmen is one arc from the forehead down to the tip.
  const arcR = ((L * L + up * up) / (2 * up)) * 0.62 + L * 0.3
  const upperArc = circle(bx - L * 0.38, by + arcR - up, arcR)
  const upper = meet(upperArc, (x, y) => Math.max(x - bx - 3, y - by, bx - L - x))
  const lower = meet(ellipse(bx + 2, by - 1.2, L * 0.8 + 2, lo + 1.2), (x, y) => Math.max(x - bx - 3, by - 1.2 - y))
  const hook = tube(path(bx - L * 0.9, by - up * 0.32, Math.PI - 0.35, 6.5 * T.bill, () => -0.3), 1.9, 0.5)
  const beak = union(upper, hook)
  const bill = turn(union(beak, lower), bx, by, tilt)
  // White grooves across the bill, curved like its base: three on the great auk; an old one has more.
  const grooved = T.marks === 'grooved'
  const grooves = []
  for (let i = 0; i < (grooved ? 5 : 3); i++) {
    const r = L * (grooved ? 0.16 + 0.15 * i : 0.3 + 0.2 * i) + 8, w = grooved ? 0.75 : 0.65
    const arc = (x, y) => Math.abs(Math.hypot(x - (bx + 8), y - by) - r) - w
    const d = meet(turn(arc, bx, by, tilt), (x, y) => bill(x, y) + 0.9)
    grooves.push(grooved ? mark(d) : part(d, { tone: 1, ink: false }))
  }
  const eyeX = hx + headR * 0.2, eyeY = hy - headR * 0.12, eyeR = 6.2
  const patch = ellipse(eyeX - eyeR * 1.1, eyeY - 0.6, eyeR * 0.95, eyeR * 0.72, 0.15)
  const look = mood === 'work' ? [-1, 0.6] : [-0.45, 0]
  // A heavy upper lid, drooping to the back: at rest the auk looks a little wistful.
  const lidLine = (x, y) => y - (eyeY - eyeR * 0.32 + (x - eyeX) * 0.2)
  const lid = mood === 'idle' ? [part(meet(circle(eyeX, eyeY, eyeR * 1.05), lidLine), { tone: dark * 0.95 })] : []
  const eyes = eye(eyeX, eyeY, eyeR, mood, { look })
  if (T.oddEye && eyes.length > 1) eyes[eyes.length - 1] = { ...eyes[eyes.length - 1], mat: 'eye' }

  // ---- markings ----------------------------------------------------------------------------
  const onHead = [], onBody = [], onWing = []
  if (T.marks === 'speckles') { // pale flecks over the crown, the back and the flipper, like sea spray
    // Placed on the bird at rest, so every spot keeps its place in every mood and frame.
    const spots = [], hx0 = 46, hy0 = bodyCy - bodyRy - headR * 0.55, body0 = ellipse(58, bodyCy, 17 * T.stout, bodyRy, -0.12)
    const rest = (f) => (x, y) => f(x + hx - hx0, y + hy - hy0)
    for (let tries = 0; spots.length < 13 && tries < 600; tries++) {
      const x = 44 + 36 * R(), y = hy0 - headR + (FLOOR.y - 8 - hy0 + headR) * R(), r = 1.5 + 0.9 * R()
      const onFlipper = flipper(x, y) < -r * 0.9
      const onHeadAt = y < hy0 + 2 && Math.hypot(x - hx0, y - hy0) < headR - r && rest(patch)(x, y) > r && rest(bill)(x, y) > r &&
        Math.hypot(x + hx - hx0 - eyeX, y + hy - hy0 - eyeY) > eyeR + r + 1
      const onBack = !onFlipper && flipper(x, y) > r && body0(x, y) < -r - 0.5 && belly(x, y) > r + 1 && y > hy0 + headR
      if ((onFlipper || onHeadAt || onBack) && spots.every(([a, b]) => Math.hypot(a - x, (b - y) * 0.6) > 5)) {
        if (onHeadAt) onHead.push(mark(circle(x + hx - hx0, y + hy - hy0, r)))
        else (onFlipper ? onWing : onBody).push(mark(circle(x, y, r)))
        spots.push([x, y])
      }
    }
  }
  if (T.marks === 'bridled') { // the bridled murre's spectacles: a white eye-ring and a line back from it
    onHead.push(mark(union(ring(eyeX, eyeY, eyeR * 1.22, eyeR * 1.12, 0.75),
      tube(path(eyeX + eyeR * 1.15, eyeY + 0.8, 0.28, eyeR * 1.9, () => 0.02), 0.95, 0.55))))
  }
  if (T.marks === 'winter') { // winter plumage: the throat and cheeks gone white
    const throat = blend(4, ellipse(hx - 3.5, hy + headR * 0.62, 8.5, 7.5, 0.3), ellipse(hx + 1, hy + headR * 1.05, 8, 6))
    const front = blend(8, chest, neck, circle(hx, hy, headR)) // the head and neck before the nod
    onHead.push(mark(meet(throat, (x, y) => Math.max(front(x, y) + 0.8, 0.5 - belly(x, y), -bill(x, y) - 0.3))))
  }

  // ---- rare extras -------------------------------------------------------------------------
  const hat = [], held = []
  if (T.extra === 'monocle') { // on a fine chain, as a gentleman of 1844 would
    const mr = eyeR * 1.38
    const chain = []
    for (let k = 0; k <= 16; k++) { const u = k / 16; chain.push([eyeX + mr * 0.5 - 3 * u, eyeY + mr * 0.85 + 17 * u - 7 * u * u]) }
    onHead.push(acc(ring(eyeX, eyeY, mr, mr, 0.95), { relief: 1.2 }), acc(tube(chain, 0.75)))
  }
  if (T.extra === 'top-hat') { // a grey topper, set back a little on the crown
    const cx = hx + 2, cy = hy - headR + 3.2
    const crown = box(cx, cy - 7.6, 7.6, 7.2, 1.2)
    const band = meet(crown, (x, y) => Math.abs(y - (cy - 2.6)) - 1.7)
    const brim = union(ellipse(cx, cy, 12.5, 1.9), circle(cx - 11.2, cy - 1, 1.6), circle(cx + 11.2, cy - 1, 1.6))
    for (const [d, o] of [[crown, { relief: 4, tone: 0.9 }], [band, { tone: 0.5 }], [brim, { relief: 2, tone: 0.85 }]]) hat.push(turnPart(acc(d, o), cx, cy, 0.14))
  }
  if (T.extra === 'scroll') { // an awk one-liner, tucked under the flipper, its end unrolled behind
    const sx = shoulder[0] - 1, sy = shoulder[1] + 11, ex = sx + 12, ey = sy - 3.5
    const roll = union(seg(sx - 9, sy + 3, ex, ey, 2.3), circle(sx - 9, sy + 3, 3))
    const sheet = union(box(ex + 3, ey + 6.5, 3.6, 6.5, 0.6), seg(ex - 0.6, ey + 13, ex + 6.6, ey + 13, 1.7))
    const line = (x, y) => (Math.abs(y - (ey + 6.5)) < 1.3 && Math.abs(x - (ex + 3)) < 2.4 ? 0.3 : 1) // the one line
    held.push(acc(sheet, { tone: 0.92, tex: line }), acc(roll, { relief: 2.3 }), acc(circle(sx - 9, sy + 3, 1.1), { tone: 0.4 }))
  }

  const headParts = [
    part(turn(lower, bx, by, tilt), { tone: 0.42, relief: 2 }),
    part(turn(beak, bx, by, tilt), { tone: 0.5, relief: 2.5 }),
    ...grooves,
    part(patch, { tone: 1, ink: false }),
    ...eyes,
    ...lid,
    ...onHead,
    ...hat,
  ].map((p) => turnPart(p, pivot[0], pivot[1], nod))

  const bird = [
    part(foot(-4), { tone: 0.24, relief: 1.5 }),
    part(silhouette, { tone: 1, relief: 10, tex: plumage }),
    ...onBody,
    ...held.map((p) => turnPart(p, shoulder[0], shoulder[1], wingUp)),
    part(wing, { tone: 0.5, relief: 3 }),
    part(bar, { tone: 0.9, ink: false }),
    ...onWing.map((p) => turnPart(p, shoulder[0], shoulder[1], wingUp)),
    part(foot(0), { tone: 0.3, relief: 1.5 }),
    ...headParts,
  ].map((p) => place(p, K, lift))

  // The rock.
  const rock = blend(6, ellipse(57, 88, 30, 11), ellipse(44, 83, 13, 6, 0.1), ellipse(72, 83, 14, 5.5, -0.15))
  const grain = (x, y) => 0.92 + 0.08 * Math.sin(x * 0.35 + Math.sin(y * 0.5) * 2)
  return { ...size, parts: [place(part(rock, { tone: 0.4, relief: 6, tex: grain })), ...bird] }
}

// The traits a hatch rolls. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['atlantic', 30], ['basalt', 20], ['floe', 18], ['kelp', 14], ['eggshell', 12], ['aurora', 6]]
export const MARKS = [[null, 35], ['grooved', 22], ['speckles', 18], ['bridled', 17], ['winter', 8]]
export const EXTRAS = [['monocle', 5], ['scroll', 4], ['top-hat', 3], [null, 88]]
const PROPS = { bill: [0.85, 1.2], stout: [0.9, 1.12], tall: [0.93, 1.08], flipper: [0.8, 1.2] }
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = ([lo, hi]) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    bill: between(PROPS.bill), stout: between(PROPS.stout), tall: between(PROPS.tall), flipper: between(PROPS.flipper),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue every species exports: colour families [name, weight, top, bottom], markings, extras
// [name, weight, colour], proportion ranges, and the accent colours markings are painted in.
// atlantic is its sea; basalt the rock of Eldey, where the last pair was taken in 1844; floe the pack
// ice; kelp the shore; eggshell the famous eggs, each scrawled like no other; aurora the rare night.
export const TRAITS = {
  colours: [['atlantic', 30, '#87ffff', '#0087af'], ['basalt', 20, '#d0d0d0', '#4e4e4e'], ['floe', 18, '#ffffff', '#87afd7'],
    ['kelp', 14, '#d7ffaf', '#5f875f'], ['eggshell', 12, '#ffffd7', '#af875f'], ['aurora', 6, '#afffd7', '#af5fd7']],
  marks: MARKS,
  extras: [['monocle', 5, '#ffd75f'], ['scroll', 4, '#ffd7af'], ['top-hat', 3, '#bcbcbc'], [null, 88, null]],
  props: PROPS,
  accents: ['#ffffff', '#ffffd7', '#afffff', '#ffd787', '#ffafaf'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['auk', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.bill, P.bill) && '--big-bill', near(tr.stout, P.stout) && '--stout', near(tr.tall, P.tall) && '--tall', near(tr.flipper, P.flipper) && '--long-flippers',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
