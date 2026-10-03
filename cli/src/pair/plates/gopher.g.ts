// Generated from daemons/plates/gopher.mjs by daemons/tools/generate.mjs. Do not edit.
// @ts-nocheck
import { circle, ellipse, box, seg, tube, path, union, meet, blend, part, eye, headroom } from './plate.g.js'

// gopher: the Gopher protocol (University of Minnesota, 1991), named after the campus mascot; for a moment it was bigger than the web.
// The state's own "gopher" is the thirteen-lined ground squirrel, and a burrow is a mine: hence
// some of its traits.
//
// Every hatch is its own gopher: the seed decides its colour, markings, proportions, rare extra and
// temper (daemons/tools/render.mjs rollTraits), and this is the same drawing with those inputs.
// Without traits it is the species plate itself.
export const size = { w: 100, h: 86 }

// The traits that draw today's gopher: every proportion 1, no markings, no extra, a calm temper.
export const DEFAULT = { cheeks: 1, teeth: 1, chub: 1, ears: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 0 }

// An individual gets two portrait rows of headroom (four at 56 columns): a gopher in a hard hat
// pops all the way up out of its hole.
const ROOM = 2

// Deterministic value noise for the dirt: clods and grains, the same every frame.
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s) }
function noise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy)
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

// Move a part's frame: `to` maps a canvas point back into the part's own coordinates; `k` is how
// much it scales distances (for relief).
function warp(p, to, k = 1) {
  return {
    ...p,
    d: (x, y) => k * p.d(...to(x, y)),
    ...(p.relief ? { relief: p.relief * k } : {}),
    ...(p.tex ? { tex: (x, y) => p.tex(...to(x, y)) } : {}),
  }
}
// Scale about the floor point, so the young sit on the same ground, smaller.
const grow = (p, s, fx, fy) => (s === 1 ? p : warp(p, (x, y) => [(x - fx) / s + fx, (y - fy) / s + fy], s))
// Tilt about a point (positive leans it to the right, clockwise on screen): the head about the
// neck, the lantern about the paw that holds it, the flower about its root.
function tilt(p, a, ox, oy) {
  if (!a) return p
  const c = Math.cos(a), s = Math.sin(a)
  return warp(p, (x, y) => { const dx = x - ox, dy = y - oy; return [ox + dx * c + dy * s, oy - dx * s + dy * c] })
}

const mark = (d, o = {}) => part(d, { tone: 0.97, mat: 'marks', ink: false, ...o })
const acc = (d, o = {}) => part(d, { tone: 0.95, mat: 'acc', ink: false, ...o })
const ring = (x, y, rx, ry, w) => (px, py) => Math.abs(ellipse(x, y, rx, ry)(px, py)) - w

// Per mood: how far out of the hole it stands, the ears (positive droops them), the head's tilt.
const MOOD = {
  idle: { rise: 0, ears: 0, tilt: 0 },
  work: { rise: -1.5, ears: 0, tilt: 0.05 },
  need: { rise: 3, ears: -0.5, tilt: -0.08 },
  done: { rise: 3, ears: 0, tilt: 0 },
  fail: { rise: -4, ears: 1, tilt: -0.12 },
  back: { rise: 1.5, ears: 0, tilt: -0.06 },
  nap: { rise: -3, ears: 0.6, tilt: 0.16 },
  boop: { rise: 1, ears: -0.4, tilt: 0.04 },
}

export function model({ t = 0, mood = 'idle', age = '2.0', traits = null } = {}) {
  const T = traits ? { ...DEFAULT, ...traits } : DEFAULT
  const a = Math.max(0.1, Math.min(2, +age || 2))
  const g = a <= 1 ? ((a - 0.1) / 0.9) * 0.55 : 0.55 + (a - 1) * 0.45 // 0 hatchling, 1 grown
  const m = MOOD[mood] || MOOD.idle
  const cx = 50, floor = 86
  const asleep = mood === 'nap'
  // A fidgety gopher runs its loop twice over (whole multiples of t), and pops up higher.
  const fidget = T.temper === 'fidgety'
  const tt = fidget ? 2 * t : t

  // life: rising a little out of the hole, a look left and right, a twitching nose
  const up = (fidget ? 2.3 : 1.8) * (1 - Math.cos(tt)) + m.rise + (mood === 'done' ? 2.5 * Math.abs(Math.sin(tt)) : 0)
  const look = asleep ? 0 : Math.sin(tt)
  const twitch = asleep ? 0 : Math.max(0, Math.sin(tt * 3)) // an irregular sniff
  const breathe = 1 + (asleep ? 0.035 : 0.02) * Math.sin(tt * 2)
  const lean = m.tilt + (asleep ? 0.02 : 0.04) * Math.sin(tt)
  const Y = (y) => y - up // everything on the gopher rides up with `up`

  // proportions: a pup is head and eyes; the grown one has the cheek pouches, teeth and claws
  const hs = 1.2 - 0.2 * g // head scale
  const bs = 0.8 + 0.2 * g // body scale
  const teeth = 0.3 + 0.7 * g
  const pouch = (0.72 + 0.28 * g) * T.cheeks // --stuffed fills them
  const hx = cx + look * 1.4 // the head turns a little with the look
  const fx = hx + look * 1.2 // and the face a little further

  // ---- the mound: a lumpy dome of turned earth, a dark hole in its crown
  const holeY = 74
  const mound = blend(9,
    ellipse(cx, 96, 49, 22),
    ellipse(cx, holeY + 1, 34, 8.5), // the crater ring the gopher pushed up
    ellipse(cx - 27, 84, 17, 7),
    ellipse(cx + 28, 85, 16, 6),
  )
  const clods = union(circle(cx - 41, 80, 2.6), circle(cx + 40, 79, 2.2), circle(cx - 31, 75, 1.8), circle(cx + 46, 84, 1.9))
  const hole = ellipse(cx, holeY, 25, 5)
  const dirt = (x, y) => 0.72 + 0.5 * (noise(x * 0.5, y * 0.8) - 0.5) + 0.3 * (noise(x * 1.6 + 9, y * 2.2) - 0.5)
  const lip = meet(mound, (x, y) => Math.max(holeY - y, -hole(x, y))) // the rim in front of the gopher

  // ---- the body: a plump sausage standing in the hole (--chubby widens it)
  const body = blend(12,
    ellipse(cx, Y(68), 20 * bs * T.chub * breathe, 16 * bs),
    ellipse(cx, Y(51) + (1 - bs) * 10, 16 * bs * T.chub * breathe, 12 * bs),
  )
  // the head's shadow on the chest, so the teeth and paws stand out against it
  const chin = (x, y) => 1 - 0.4 * Math.exp(-(((x - hx) / 13) ** 2) - (((y - Y(47)) / 6) ** 2))

  // little paws held up at the chest under the teeth, digging claws hanging down
  const pawY = Y(49.5) + (mood === 'work' ? 1.5 * Math.sin(tt * 2) : 0)
  const paw = (px, py, down = 1) => ({
    hand: ellipse(px, py + 0.5, 4.2 * bs, 4.4 * bs),
    claws: union(...[-1, 0, 1].map((k) => seg(px + k * 2 * bs, py + down * 3.5 * bs, px + k * 2.4 * bs, py + down * (4.6 + 2.8 * teeth) * bs, 0.85 * bs, 0.4 * bs))),
  })
  const waving = mood === 'back'
  const lantern = T.extra === 'lantern' // the left paw is up, holding it
  const paws = [-1, 1].map((s) => {
    if ((waving && s > 0) || (lantern && s < 0)) return null
    const px = cx + s * 4.6 * bs
    return { arm: seg(cx + s * 12 * bs * T.chub, Y(57), px + s * 1.5, pawY + 1, 3.6 * bs, 3 * bs), ...paw(px, pawY) }
  }).filter(Boolean)
  // on `back` the right paw comes up beside the cheek in a little wave
  const wx = cx + 24 * bs * T.chub + Math.sin(tt * 2) * 1.5, wy = Y(44)
  const wave = waving ? { arm: seg(cx + 13 * bs * T.chub, Y(58), wx, wy + 2, 3.8 * bs, 3.2 * bs), ...paw(wx, wy, -1) } : null
  // with a lantern the left paw holds it up the same way
  const lx = cx - 24 * bs - 7 * T.chub * bs, ly = Y(42)
  const hold = lantern ? { arm: seg(cx - 13 * bs * T.chub, Y(58), lx, ly + 2, 3.8 * bs, 3.2 * bs), ...paw(lx, ly, -1) } : null

  // ---- the head: round, with fat cheek pouches low on each side
  const headY = Y(24) + (1 - bs) * 18
  const rx = 20 * hs, ry = 17 * hs
  const earX = 17.5 * hs + (T.ears - 1) * 4 * hs + m.ears * 2, earY = headY - 11 * hs + m.ears * 3
  const ears = [-1, 1].map((s) => circle(hx + s * earX, earY, 4.7 * hs * T.ears))
  const earIn = [-1, 1].map((s) => circle(hx + s * (earX + 0.6 * T.ears), earY + 0.6 * T.ears, 2.3 * hs * T.ears))

  const cheek = [11 * pouch * hs, 9 * pouch * hs]
  const px = (15 + (T.cheeks - 1) * 5) * hs, py = headY + (8 + (T.cheeks - 1) * 4) * hs
  const head = blend(8,
    ellipse(hx, headY, rx, ry),
    ellipse(hx - px, py, ...cheek),
    ellipse(hx + px, py, ...cheek),
  )

  const mzY = headY + (10.5 - g) * hs
  const muzzle = ellipse(fx, mzY, 10 * hs, 7 * hs)
  const nb = mood === 'boop' ? 1.3 : 1 // a booped nose scrunches up big
  const nose = ellipse(fx + look * 0.4, mzY - 3.6 * hs - twitch, (3.6 + twitch) * hs * nb, (2.4 + twitch * 0.4) * hs * nb)
  const mouthY = mzY + 4 * hs
  const mouth = ellipse(fx, mouthY, 5.5 * hs, 2.8 * hs)
  const tw = 2.1 * hs, th = 5 * teeth * hs * T.teeth // --buck-teeth
  const tooth = [-1, 1].map((s) => box(fx + s * (tw + 0.35), mouthY + th * 0.9, tw, th, 0.7))
  const gum = box(fx, mouthY + th * 0.9, tw * 2 + 1.4, th + 1.1, 1.4) // a dark ring so the teeth pop

  // whiskers sit behind the head, so only the tips past the cheeks show
  const wb = 20 + (T.cheeks - 1) * 16
  const whiskers = union(...[-1, 1].flatMap((s) => [
    seg(fx + s * wb * hs, mzY - 1 * hs, fx + s * (wb + 13 * g) * hs, mzY - (1 + 3 * g) * hs - twitch * 0.5, 0.45, 0.25),
    seg(fx + s * wb * hs, mzY + 1.5 * hs, fx + s * (wb + 12 * g) * hs, mzY + (1.5 + 1.5 * g) * hs + twitch * 0.5, 0.45, 0.25),
  ]))

  const eyeR = 5.8 * hs * (1.12 - 0.12 * g) // a pup's eyes are big for its face
  const eyes = [-1, 1].flatMap((s) => {
    const e = eye(fx + s * (10.5 - g) * hs, headY - (3 - 2 * g) * hs, eyeR, mood, { look: [look * 0.6, 0.15] })
    // The odd eye: the right one's pupil, in a colour of its own.
    if (T.oddEye && s > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    return e
  })

  // ---- markings, painted in the individual's accent colour
  const bodyMarks = [], headMarks = []
  const skull = ellipse(hx, headY, rx, ry)
  if (T.marks === 'bib') { // a pale throat and belly
    const bib = blend(6, ellipse(cx, Y(53) + (1 - bs) * 10, 7.5 * T.chub * bs, 5 * bs), ellipse(cx, Y(64), 11.5 * T.chub * bs, 9.5 * bs))
    bodyMarks.push(mark(meet(bib, body), { relief: 6, tone: 0.95 }))
  }
  if (T.marks === 'blaze') { // a white star run up the forehead, from the nose to the crown
    headMarks.push(mark(meet(seg(fx, headY + 2 * hs, hx, headY - 15 * hs, 1.4 * hs, 3.4 * hs), skull)))
  }
  if (T.marks === 'lined') { // the thirteen-lined ground squirrel: stripes and rows of dots
    const inset = (d, w) => (x, y) => Math.abs(body(x, y) + d) - w
    bodyMarks.push(mark(inset(3.4, 1.4)), mark(meet(inset(9, 1.6), (x, y) => Math.abs(((y - Y(0)) % 5.5 + 5.5) % 5.5 - 2.75) - 1.4)))
    for (const k of [-1, 0, 1]) {
      const d = k ? seg(hx + k * 6 * hs, headY - 7 * hs, hx + k * 7.5 * hs, headY - 16 * hs, 1.3 * hs) : union(...[0, 1, 2].map((i) => circle(hx, headY - (8 + i * 3.8) * hs, 1.6 * hs)))
      headMarks.push(mark(meet(d, skull)))
    }
  }
  const mitts = T.marks === 'mittens' // white front paws

  // ---- rare extras
  const hat = []
  if (T.extra === 'hardhat') { // a miner's hard hat with its lamp lit: down the burrow
    const rim = headY - 13.5 * hs
    hat.push(acc(meet(ellipse(hx, rim - 0.5 * hs, 14 * hs, 11 * hs), (x, y) => y - rim), { relief: 6, tone: 0.6, ink: true }))
    hat.push(acc(seg(hx, rim - 10.5 * hs, hx, rim - 8 * hs, 1.3 * hs), { tone: 1 }))
    hat.push(acc(ellipse(hx, rim + 0.3 * hs, 18 * hs, 2.2 * hs), { relief: 2, tone: 0.62, ink: true }))
    hat.push(acc(circle(fx, rim - 4.8 * hs, 4.1 * hs), { tone: 0.12 }))
    hat.push(acc(circle(fx, rim - 4.8 * hs, 2.9 * hs), { tone: 1 }))
  }
  const lamp = []
  if (lantern) { // a miner's lantern, held up by its bail, swinging a little under the paw
    const swing = (fidget ? 0.2 : 0.12) * Math.sin(tt + 0.8)
    const top = ly + 4 * bs
    const glow = 0.94 + 0.06 * Math.sin(tt * 3)
    lamp.push(
      acc(meet(ring(lx, top + 1 * bs, 3.2 * bs, 3.6 * bs, 0.55), (x, y) => y - (top + 1 * bs))),
      acc(box(lx, top + 2.2 * bs, 3.4 * bs, 1.3 * bs, 0.6), { relief: 1.5, tone: 0.75 }),
      acc(box(lx, top + 7.2 * bs, 3.1 * bs, 3.9 * bs, 1.2), { tone: glow }),
      acc(union(seg(lx - 3.4 * bs, top + 3.4 * bs, lx - 3.4 * bs, top + 11 * bs, 0.65), seg(lx + 3.4 * bs, top + 3.4 * bs, lx + 3.4 * bs, top + 11 * bs, 0.65)), { tone: 0.45 }),
      acc(box(lx, top + 11.8 * bs, 4.1 * bs, 1.2 * bs, 0.5), { relief: 1.5, tone: 0.75 }),
    )
    lamp.forEach((p, i) => { lamp[i] = tilt(p, swing, lx, ly) })
  }
  const bloom = []
  if (T.extra === 'flower') { // the campus flower come up on the mound, nodding
    const sway = (fidget ? 0.16 : 0.1) * Math.sin(tt + 0.6)
    const rootX = cx + 37, rootY = 81
    const stem = path(rootX, rootY, -Math.PI / 2 - 0.08, 15, (u) => 0.012 * Math.sin(u * Math.PI))
    const [fx0, fy0] = stem[stem.length - 1]
    const petals = union(...[0, 1, 2, 3, 4].map((k) => { const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5; return circle(fx0 + Math.cos(a) * 3.3, fy0 + Math.sin(a) * 3.3, 2.5) }))
    bloom.push(
      part(tube(stem, 0.85, 0.65), { tone: 0.7, ink: false }),
      part(ellipse(rootX + 3, rootY - 6, 3.2, 1.3, -0.5), { tone: 0.7, ink: false }),
      acc(petals, { relief: 2, tone: 1 }),
      part(circle(fx0, fy0, 1.9), { tone: 0.95, ink: false }),
    )
    bloom.forEach((p, i) => { bloom[i] = tilt(p, sway, rootX, rootY) })
  }

  const neck = [hx, headY + 16 * hs]
  const earParts = [
    ...ears.map((d) => part(d, { relief: 3, tone: 0.8 })),
    ...earIn.map((d) => part(d, { tone: 0.2, ink: false })),
  ].map((p) => tilt(p, lean, ...neck))
  const headParts = [
    part(whiskers, { tone: 0.75, ink: false }),
    part(head, { relief: 9, tone: 0.86 }),
    ...headMarks,
    part(muzzle, { relief: 4, tone: 0.98, ink: false }),
    part(mouth, { tone: 0.05, ink: false }),
    part(gum, { tone: 0.12, ink: false }),
    ...tooth.map((d) => part(d, { tone: 1, ink: false })),
    part(nose, { tone: 0.08, ink: false }),
    ...eyes,
    ...hat,
  ].map((p) => tilt(p, lean, ...neck))

  const pawParts = (p) => [part(p.arm, { relief: 3, tone: 0.66 }), part(p.claws, { tone: 0.95 }), part(p.hand, { relief: 3, tone: 1.25, ...(mitts ? { mat: 'marks' } : {}) })]
  const gopher = [
    ...earParts,
    part(body, { relief: 10, tone: 0.78, tex: chin }),
    ...bodyMarks,
    ...paws.flatMap(pawParts),
    ...headParts,
    ...(wave ? pawParts(wave) : []),
    ...lamp,
    ...(hold ? pawParts(hold) : []),
  ]

  const earth = [
    part(mound, { relief: 7, tone: 0.6, tex: dirt }),
    part(clods, { relief: 1.5, tone: 0.62, tex: dirt }),
    part(hole, { tone: 0.03, ink: false }),
  ]
  const front = [part(lip, { relief: 4, tone: 0.64, tex: dirt })]

  const s = 0.66 + 0.34 * g
  const parts = [...earth, ...gopher, ...front, ...bloom].map((p) => grow(p, s, cx, floor))
  return traits ? headroom({ ...size, parts }, ROOM) : { ...size, parts }
}
