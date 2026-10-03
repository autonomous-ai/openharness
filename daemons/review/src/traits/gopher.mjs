import { circle, ellipse, box, seg, tube, path, union, meet, blend, part, eye } from '../eggproto/plate.mjs'

// gopher with traits: every hatch is its own pocket gopher. The seed decides colour, markings,
// proportions, rare extras and temperament; the drawing is the same model with different inputs.
// The Gopher protocol (University of Minnesota, 1991) was named after the campus mascot; the state's
// own "gopher" is the thirteen-lined ground squirrel, and the burrow is a mine: hence the traits.
// Grown (2.0) only. The canvas has three rows more headroom than the repo model (a row at 56 columns
// is 43/12 units), so a gopher in a hard hat can pop all the way up; the rest is unchanged.
const DY = 43 / 4
export const size = { w: 100, h: 86 + DY }

export const DEFAULT = { cheeks: 1, teeth: 1, chub: 1, ears: 1, marks: null, extra: null, oddEye: false, temper: 'calm', seed: 1 }

// A small repeatable random stream from a seed.
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// Deterministic value noise for the dirt: clods and grains, the same every frame.
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s) }
function noise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy)
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

// Move a part's frame: `to` maps a canvas point back into the part's own coordinates.
function warp(p, to) {
  return { ...p, d: (x, y) => p.d(...to(x, y)), ...(p.tex ? { tex: (x, y) => p.tex(...to(x, y)) } : {}) }
}
// Tilt about a point (positive leans it to the right, clockwise on screen): the head about the
// neck, the lantern about the paw that holds it, the flower about its root.
function tilt(p, a, ox, oy) {
  if (!a) return p
  const c = Math.cos(a), s = Math.sin(a)
  return warp(p, (x, y) => { const dx = x - ox, dy = y - oy; return [ox + dx * c + dy * s, oy - dx * s + dy * c] })
}
const shift = (p) => warp(p, (x, y) => [x, y - DY])

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

export function model({ t = 0, mood = 'idle', traits = DEFAULT } = {}) {
  const T = { ...DEFAULT, ...traits }
  const m = MOOD[mood] || MOOD.idle
  const cx = 50
  const asleep = mood === 'nap'
  const fidget = T.temper === 'fidgety'
  const tt = fidget ? 2 * t : t // a fidgety gopher runs its loop twice over, and pops up higher

  // life: rising a little out of the hole, a look left and right, a twitching nose
  const up = (fidget ? 2.3 : 1.8) * (1 - Math.cos(tt)) + m.rise + (mood === 'done' ? 2.5 * Math.abs(Math.sin(tt)) : 0)
  const look = asleep ? 0 : Math.sin(tt)
  const twitch = asleep ? 0 : Math.max(0, Math.sin(tt * 3)) // an irregular sniff
  const breathe = 1 + (asleep ? 0.035 : 0.02) * Math.sin(tt * 2)
  const lean = m.tilt + (asleep ? 0.02 : 0.04) * Math.sin(tt)
  const Y = (y) => y - up // everything on the gopher rides up with `up`

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
    ellipse(cx, Y(68), 20 * T.chub * breathe, 16),
    ellipse(cx, Y(51), 16 * T.chub * breathe, 12),
  )
  // the head's shadow on the chest, so the teeth and paws stand out against it
  const chin = (x, y) => 1 - 0.4 * Math.exp(-(((x - hx) / 13) ** 2) - (((y - Y(47)) / 6) ** 2))

  // little paws held up at the chest under the teeth, digging claws hanging down
  const pawY = Y(49.5) + (mood === 'work' ? 1.5 * Math.sin(tt * 2) : 0)
  const paw = (px, py, down = 1) => ({
    hand: ellipse(px, py + 0.5, 4.2, 4.4),
    claws: union(...[-1, 0, 1].map((k) => seg(px + k * 2, py + down * 3.5, px + k * 2.4, py + down * (4.6 + 2.8), 0.85, 0.4))),
  })
  const waving = mood === 'back'
  const lantern = T.extra === 'lantern' // the left paw is up, holding it
  const paws = [-1, 1].map((s) => {
    if ((waving && s > 0) || (lantern && s < 0)) return null
    const px = cx + s * 4.6
    return { arm: seg(cx + s * 12 * T.chub, Y(57), px + s * 1.5, pawY + 1, 3.6, 3), ...paw(px, pawY) }
  }).filter(Boolean)
  // on `back` the right paw comes up beside the cheek in a little wave
  const wx = cx + 24 * T.chub + Math.sin(tt * 2) * 1.5, wy = Y(44)
  const wave = waving ? { arm: seg(cx + 13 * T.chub, Y(58), wx, wy + 2, 3.8, 3.2), ...paw(wx, wy, -1) } : null
  const lx = cx - 24 - 7 * T.chub, ly = Y(42)
  const hold = lantern ? { arm: seg(cx - 13 * T.chub, Y(58), lx, ly + 2, 3.8, 3.2), ...paw(lx, ly, -1) } : null

  // ---- the head: round, with fat cheek pouches low on each side (--stuffed fills them)
  const headY = Y(24)
  const rx = 20, ry = 17
  const earX = 17.5 + (T.ears - 1) * 4 + m.ears * 2, earY = headY - 11 + m.ears * 3
  const ears = [-1, 1].map((s) => circle(hx + s * earX, earY, 4.7 * T.ears))
  const earIn = [-1, 1].map((s) => circle(hx + s * (earX + 0.6 * T.ears), earY + 0.6 * T.ears, 2.3 * T.ears))

  const pouch = T.cheeks, px = 15 + (pouch - 1) * 5
  const cheek = [11 * pouch, 9 * pouch]
  const head = blend(8,
    ellipse(hx, headY, rx, ry),
    ellipse(hx - px, headY + 8 + (pouch - 1) * 4, ...cheek),
    ellipse(hx + px, headY + 8 + (pouch - 1) * 4, ...cheek),
  )

  const mzY = headY + 9.5
  const muzzle = ellipse(fx, mzY, 10, 7)
  const nb = mood === 'boop' ? 1.3 : 1 // a booped nose scrunches up big
  const nose = ellipse(fx + look * 0.4, mzY - 3.6 - twitch, (3.6 + twitch) * nb, (2.4 + twitch * 0.4) * nb)
  const mouthY = mzY + 4
  const mouth = ellipse(fx, mouthY, 5.5, 2.8)
  const tw = 2.1, th = 5 * T.teeth // --buck-teeth
  const tooth = [-1, 1].map((s) => box(fx + s * (tw + 0.35), mouthY + th * 0.9, tw, th, 0.7))
  const gum = box(fx, mouthY + th * 0.9, tw * 2 + 1.4, th + 1.1, 1.4) // a dark ring so the teeth pop

  // whiskers sit behind the head, so only the tips past the cheeks show
  const wb = 20 + (pouch - 1) * 16
  const whiskers = union(...[-1, 1].flatMap((s) => [
    seg(fx + s * wb, mzY - 1, fx + s * (wb + 13), mzY - (1 + 3) - twitch * 0.5, 0.45, 0.25),
    seg(fx + s * wb, mzY + 1.5, fx + s * (wb + 12), mzY + (1.5 + 1.5) + twitch * 0.5, 0.45, 0.25),
  ]))

  const eyeR = 5.8
  const eyes = [-1, 1].flatMap((s) => {
    const e = eye(fx + s * 9.5, headY - 1, eyeR, mood, { look: [look * 0.6, 0.15] })
    if (T.oddEye && s > 0 && e.length > 1) e[e.length - 1] = { ...e[e.length - 1], mat: 'eye' }
    return e
  })

  // ---- markings, painted in the individual's accent colour
  const bodyMarks = [], headMarks = []
  if (T.marks === 'bib') { // a pale throat and belly
    const bib = blend(6, ellipse(cx, Y(53), 7.5 * T.chub, 5), ellipse(cx, Y(64), 11.5 * T.chub, 9.5))
    bodyMarks.push(mark(meet(bib, body), { relief: 6, tone: 0.95 }))
  }
  if (T.marks === 'blaze') { // a white star run up the forehead, from the nose to the crown
    headMarks.push(mark(meet(seg(fx, headY + 2, hx, headY - 15, 1.4, 3.4), ellipse(hx, headY, rx, ry))))
  }
  if (T.marks === 'lined') { // the thirteen-lined ground squirrel: stripes and rows of dots
    const inset = (d, w) => (x, y) => Math.abs(body(x, y) + d) - w
    bodyMarks.push(mark(inset(3.4, 1.4)), mark(meet(inset(9, 1.6), (x, y) => Math.abs(((y - Y(0)) % 5.5 + 5.5) % 5.5 - 2.75) - 1.4)))
    for (const k of [-1, 0, 1]) {
      const d = k ? seg(hx + k * 6, headY - 7, hx + k * 7.5, headY - 16, 1.3) : union(...[0, 1, 2].map((i) => circle(hx, headY - 8 - i * 3.8, 1.6)))
      headMarks.push(mark(meet(d, ellipse(hx, headY, rx, ry))))
    }
  }
  const mitts = T.marks === 'mittens' // white front paws

  // ---- rare extras
  const hat = []
  if (T.extra === 'hardhat') { // a miner's hard hat with its lamp lit
    const rim = headY - 13.5
    hat.push(acc(meet(ellipse(hx, rim - 0.5, 14, 11), (x, y) => y - rim), { relief: 6, tone: 0.6, ink: true }))
    hat.push(acc(seg(hx, rim - 10.5, hx, rim - 8, 1.3), { tone: 1 }))
    hat.push(acc(ellipse(hx, rim + 0.3, 18, 2.2), { relief: 2, tone: 0.62, ink: true }))
    hat.push(acc(circle(fx, rim - 4.8, 4.1), { tone: 0.12 }))
    hat.push(acc(circle(fx, rim - 4.8, 2.9), { tone: 1 }))
  }
  const lamp = []
  if (lantern) { // held up by its bail, swinging a little under the paw
    const swing = (fidget ? 0.2 : 0.12) * Math.sin(tt + 0.8)
    const top = ly + 4
    const glow = 0.94 + 0.06 * Math.sin(tt * 3)
    lamp.push(
      acc(meet(ring(lx, top + 1, 3.2, 3.6, 0.55), (x, y) => y - (top + 1))),
      acc(box(lx, top + 2.2, 3.4, 1.3, 0.6), { relief: 1.5, tone: 0.75 }),
      acc(box(lx, top + 7.2, 3.1, 3.9, 1.2), { tone: glow }),
      acc(union(seg(lx - 3.4, top + 3.4, lx - 3.4, top + 11, 0.65), seg(lx + 3.4, top + 3.4, lx + 3.4, top + 11, 0.65)), { tone: 0.45 }),
      acc(box(lx, top + 11.8, 4.1, 1.2, 0.5), { relief: 1.5, tone: 0.75 }),
    )
    lamp.forEach((p, i) => { lamp[i] = tilt(p, swing, lx, ly) })
  }
  const bloom = []
  if (T.extra === 'flower') { // a flower come up on the mound, nodding
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

  const neck = [hx, headY + 16]
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

  const parts = [...earth, ...gopher, ...front, ...bloom].map(shift)
  return { ...size, parts }
}

// The traits a hatch rolls. `odds` are the real ones; the lookbook picks seeds that show them all.
export const COLOURS = [['prairie', 30], ['cinnamon', 20], ['dune', 18], ['silt', 14], ['coal', 12], ['goldy', 6]]
export const MARKS = [[null, 35], ['mittens', 22], ['bib', 18], ['blaze', 17], ['lined', 8]]
export const EXTRAS = [['flower', 5], ['lantern', 4], ['hardhat', 3], [null, 88]]
function pick(r, list) { const total = list.reduce((a, [, w]) => a + w, 0); let x = r() * total; for (const [v, w] of list) { if ((x -= w) < 0) return v } return list[0][0] }
export function roll(seed) {
  const r = rng(seed)
  const between = (lo, hi) => Math.round((lo + (hi - lo) * r()) * 100) / 100
  return {
    seed, colour: pick(r, COLOURS), marks: pick(r, MARKS), extra: pick(r, EXTRAS), oddEye: r() < 0.02,
    cheeks: between(0.8, 1.3), teeth: between(0.75, 1.45), chub: between(0.88, 1.16), ears: between(0.8, 1.35),
    temper: r() < 0.3 ? 'fidgety' : 'calm',
  }
}

// The catalogue: colour families [name, weight, top, bottom], markings, extras [name, weight,
// colour], proportion ranges, and the accent colours markings are painted in.
// prairie is today's gopher; cinnamon and dune are the reddish and the pale desert pocket gophers;
// silt the grey valley one; coal the black one (a miner's colour); goldy the campus mascot, rare.
export const TRAITS = {
  colours: [['prairie', 30, '#d7af87', '#875f00'], ['cinnamon', 20, '#ffaf87', '#af5f5f'], ['dune', 18, '#ffffd7', '#d7af5f'],
    ['silt', 14, '#d7d7af', '#87875f'], ['coal', 12, '#8a8a8a', '#3a3a3a'], ['goldy', 6, '#ffd75f', '#d78700']],
  marks: MARKS,
  extras: [['flower', 5, '#ff87d7'], ['lantern', 4, '#ffaf5f'], ['hardhat', 3, '#ffd700'], [null, 88, null]],
  props: { cheeks: [0.8, 1.3], teeth: [0.75, 1.45], chub: [0.88, 1.16], ears: [0.8, 1.35] },
  accents: ['#ffffd7', '#eeeeee', '#ffd7af', '#ffd787', '#ffd7d7'],
}
const near = (v, [lo, hi]) => v >= hi - (hi - lo) * 0.2
export function flags(tr) {
  const P = TRAITS.props
  return ['gopher', '-c ' + tr.colour, tr.marks && '--' + tr.marks, tr.extra && '--' + tr.extra, tr.oddEye && '--odd-eye',
    near(tr.cheeks, P.cheeks) && '--stuffed', near(tr.teeth, P.teeth) && '--buck-teeth', near(tr.chub, P.chub) && '--chubby', near(tr.ears, P.ears) && '--big-ears',
    tr.temper === 'fidgety' && '--fidgety'].filter(Boolean).join(' ')
}
export function oneIn(tr) {
  const w = (list, v) => { const total = list.reduce((a, x) => a + x[1], 0); return (list.find((x) => x[0] === v)?.[1] ?? 0) / total }
  const p = w(TRAITS.colours, tr.colour) * w(TRAITS.marks, tr.marks) * w(TRAITS.extras, tr.extra) * (tr.oddEye ? 0.02 : 0.98)
  return Math.round(1 / p)
}
