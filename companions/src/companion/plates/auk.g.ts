// Generated from daemons/plates/auk.mjs by daemons/tools/generate.mjs. Do not edit.
// @ts-nocheck
import { circle, ellipse, box, seg, tube, path, blend, union, meet, part, eye, rng, headroom } from './plate.g.js'

// auk: awk (Aho, Weinberger and Kernighan, Bell Labs, 1977) and the great auk, the first bird ever
// called a penguin, extinct since 1844; awk is still in every Unix.
//
// Every hatch is its own great auk: the seed decides its colour, markings, proportions, rare extra
// and temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 100, h: 86 }

const FLOOR = { x: 57, y: 76 } // where the feet meet the rock; the young stand here too
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v))
const mix = (a, b, u) => a + (b - a) * u
const smooth = (e0, e1, v) => { const u = clamp((v - e0) / (e1 - e0)); return u * u * (3 - 2 * u) }

// The traits that draw today's auk: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { bill: 1, stout: 1, tall: 1, flipper: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// An individual gets three portrait rows of headroom (six at 56 columns), for a top hat on a tall
// auk mid-hop.
const ROOM = 3

// Turn a shape (or a texture) by `a` radians about (px, py), clockwise on screen (y down).
function turn(f, px, py, a) {
  if (!a) return f
  const c = Math.cos(a), s = Math.sin(a)
  return (x, y) => { const dx = x - px, dy = y - py; return f(px + c * dx + s * dy, py - s * dx + c * dy) }
}
const turnPart = (p, px, py, a) => ({ ...p, d: turn(p.d, px, py, a), tex: p.tex && turn(p.tex, px, py, a) })

// Scale a finished part by k about the floor point and raise it by `lift` (a hop).
function grow(p, k, lift) {
  if (k === 1 && !lift) return p
  const at = (f) => (x, y) => f(FLOOR.x + (x - FLOOR.x) / k, FLOOR.y + (y - FLOOR.y + lift) / k)
  const d = at(p.d)
  return { ...p, d: (x, y) => d(x, y) * k, tex: p.tex && at(p.tex), relief: p.relief && p.relief * k }
}

// '0.1' a grey downy chick, '1.0' a young auk, '2.0' the great auk: g runs 0, 0.55, 1.
function growth(age) {
  const a = parseFloat(age)
  if (!Number.isFinite(a)) return 1
  return clamp(a <= 1 ? ((a - 0.1) / 0.9) * 0.55 : 0.55 + (a - 1) * 0.45)
}

const mark = (d) => part(d, { tone: 0.97, mat: 'marks', ink: false })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const R = rng(T.seed * 7919)
  // A fidgety auk bobs twice as fast and further, and flicks a flipper (whole multiples of t).
  const fidget = T.temper === 'fidgety'
  const ft = fidget ? 2 * t : t, amp = fidget ? 1.8 : 1
  const g = growth(age), baby = 1 - g
  const k = mix(0.66, 1.05, g)

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
  const bodyRy = mix(16, 23, g) * T.tall, bodyCy = FLOOR.y - 1 - bodyRy
  const bodyRx = mix(18, 17, g) * T.stout
  const body = ellipse(58, bodyCy, bodyRx * swell, bodyRy, -0.12)
  const chest = ellipse(mix(55, 51, g), bodyCy - bodyRy * 0.3, mix(13, 12, g) * T.stout * swell, mix(11, 12, g))
  const headR = mix(19, 14, g)
  const hx0 = mix(51, 46, g), hy0 = bodyCy - bodyRy * mix(0.95, 1.0, g) - headR * mix(0.35, 0.55, g) // the head at rest
  const hx = hx0 + headDx, hy = hy0 + headDy
  const pivot = [55, bodyCy - bodyRy * 0.7] // the neck
  const head = turn(circle(hx, hy, headR), pivot[0], pivot[1], nod)
  const neck = seg(57, bodyCy - bodyRy * 0.55, hx + 3, hy + headR * 0.4, mix(12, 10, g), mix(11, 8.5, g))
  const tail = seg(67 + (T.stout - 1) * 12, FLOOR.y - 8, 80 - baby * 6, FLOOR.y - 1.5, 3.8, 0.8)
  const silhouette = blend(8, body, chest, neck, head, tail)

  // White from the throat down, ending in a point on the foreneck; the rest black as a dinner jacket.
  const belly = ellipse(mix(54, 50.5, g), bodyCy + bodyRy * 0.12, mix(13, 14.5, g) * T.stout, bodyRy * 1.08, -0.1)
  const dark = mix(0.66, 0.56, g), white = mix(0.8, 0.95, g)
  const fluff = (x, y) => 1 + baby * 0.14 * Math.sin(x * 2.1 + Math.sin(y * 1.7) * 2) * Math.sin(y * 1.9)
  const plumage = (x, y) => mix(dark, white, smooth(0.8, -0.8, belly(x, y))) * fluff(x, y)

  // Flipper: small, held at the side, pointing down and back.
  const shoulder = [63 + (T.stout - 1) * 12, bodyCy - bodyRy * 0.5]
  const flipper = tube(path(shoulder[0], shoulder[1], 1.42, mix(13, 27, g) * T.flipper, (u) => 0.012 + 0.02 * u), mix(4, 5.4, g), 1.1)
  const wing = turn(flipper, shoulder[0], shoulder[1], wingUp)
  // The white bar along its trailing edge, from the tips of the secondaries.
  const bar = turn((x, y) => Math.max(flipper(x, y), -flipper(x + 1.5, y), shoulder[1] + 6 - y), shoulder[0], shoulder[1], wingUp)

  // Feet: black, webbed, flat on the rock, toes forward.
  const foot = (dx) => blend(2, seg(63 + dx, FLOOR.y - 4, 62 + dx, FLOOR.y - 1.2, 2.4, 2), seg(62 + dx, FLOOR.y - 1.2, mix(54, 48, g) + dx, FLOOR.y - 0.8, 2, 1.1))

  // ---- the head: the deep, grooved, hooked bill and the white oval ------------------------
  // The bill is drawn level, facing left from its gape (bx, by), then tipped down a little. A bigger
  // bill is longer, and deeper by less.
  const bx = hx - headR * mix(0.92, 0.8, g), by = hy + headR * 0.3
  const deep = 1 + (T.bill - 1) * 0.7
  const L = mix(8, 19, g) * T.bill, up = mix(5.5, 10.5, g) * deep, lo = mix(3.5, 5.5, g) * deep, tilt = -0.08
  // The culmen is one arc from the forehead down to the tip.
  const arcR = ((L * L + up * up) / (2 * up)) * 0.62 + L * 0.3
  const upperArc = circle(bx - L * 0.38, by + arcR - up, arcR)
  const upper = meet(upperArc, (x, y) => Math.max(x - bx - 3, y - by, bx - L - x))
  const lower = meet(ellipse(bx + 2, by - 1.2, L * 0.8 + 2, lo + 1.2), (x, y) => Math.max(x - bx - 3, by - 1.2 - y))
  const hook = tube(path(bx - L * 0.9, by - up * 0.32, Math.PI - 0.35, mix(2, 6.5, g) * T.bill, () => -0.3), mix(0.9, 1.9, g), 0.5)
  const beak = g > 0.3 ? union(upper, hook) : upper
  const bill = turn(union(beak, lower), bx, by, tilt)
  // White grooves across the bill, curved like its base: three on the great auk, a hint on the chick.
  // Grooved: an old bird's bill, with two more, painted in the accent colour.
  const n = g < 0.3 ? 1 : g < 0.8 ? 2 : 3
  const grooved = T.marks === 'grooved'
  const count = grooved ? n + 2 : n
  const grooves = []
  for (let i = 0; i < count; i++) {
    const r = L * (grooved ? 0.16 + (0.6 / (count - 1)) * i : n === 1 ? 0.5 : 0.3 + 0.2 * i) + 8
    const w = grooved ? 0.75 : mix(0.75, 0.65, g)
    const arc = (x, y) => Math.abs(Math.hypot(x - (bx + 8), y - by) - r) - w
    const d = meet(turn(arc, bx, by, tilt), (x, y) => bill(x, y) + 0.9)
    grooves.push(grooved ? mark(d) : part(d, { tone: n === 1 ? 0.7 : 1, ink: false }))
  }
  const eyeX = hx + headR * 0.2, eyeY = hy - headR * 0.12, eyeR = mix(7.8, 6.2, g)
  const patch = ellipse(eyeX - eyeR * mix(0.9, 1.1, g), eyeY - 0.6, eyeR * mix(0.7, 0.95, g), eyeR * mix(0.6, 0.72, g), 0.15)
  const look = mood === 'work' ? [-1, 0.6] : [-0.45, 0]
  // A heavy upper lid, drooping to the back: at rest the auk looks a little wistful.
  const lidLine = (x, y) => y - (eyeY - eyeR * 0.32 + (x - eyeX) * 0.2)
  const lid = mood === 'idle' && g > 0.5 ? [part(meet(circle(eyeX, eyeY, eyeR * 1.05), lidLine), { tone: dark * 0.95 })] : []
  const eyes = eye(eyeX, eyeY, eyeR, mood, { look })
  // The odd eye: its pupil, in a colour of its own.
  if (T.oddEye && eyes.length > 1) eyes[eyes.length - 1] = { ...eyes[eyes.length - 1], mat: 'eye' }

  // ---- markings ----------------------------------------------------------------------------
  const onHead = [], onBody = [], onWing = []
  if (T.marks === 'speckles') { // pale flecks over the crown, the back and the flipper, like sea spray
    // Placed on the bird at rest, so every fleck keeps its place in every mood and frame.
    const spots = [], body0 = ellipse(58, bodyCy, bodyRx, bodyRy, -0.12)
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
    for (let i = 0; i <= 16; i++) { const u = i / 16; chain.push([eyeX + mr * 0.5 - 3 * u, eyeY + mr * 0.85 + 17 * u - 7 * u * u]) }
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
    part(patch, { tone: mix(0.62, 1, g), ink: false }),
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
    part(wing, { tone: mix(0.58, 0.5, g), relief: 3 }),
    part(bar, { tone: mix(0.6, 0.9, g), ink: false }),
    ...onWing.map((p) => turnPart(p, shoulder[0], shoulder[1], wingUp)),
    part(foot(0), { tone: 0.3, relief: 1.5 }),
    ...headParts,
  ].map((p) => grow(p, k, lift))

  // The rock, the same at every age.
  const rock = blend(6, ellipse(57, 88, 30, 11), ellipse(44, 83, 13, 6, 0.1), ellipse(72, 83, 14, 5.5, -0.15))
  const grain = (x, y) => 0.92 + 0.08 * Math.sin(x * 0.35 + Math.sin(y * 0.5) * 2)
  const out = { ...size, parts: [part(rock, { tone: 0.4, relief: 6, tex: grain }), ...bird] }
  return traits ? headroom(out, ROOM) : out
}
