import { ellipse, circle, tube, part, seg, meet, union } from '../tools/plate.mjs'

// The egg: one shell for every kind (its pattern and colour tell them apart, the way a blind box's
// art tells you the series), cracked so it reads. It cracks as you earn it: part way across, then all
// the way with a chip knocked out, then split a little with light inside; earned, it rocks in the nest
// with two eyes peeking out of the chip. Opened, it rocks hard, the top lifts and light pours out (in
// the rarity's colour: the client's), the top breaks in two and tumbles off either side, bits of shell
// scatter, and the bottom half is left for the hatchling to rise out of.
//
//   stage 'rest'                   whole, breathing                                        (p0)
//   stage 'crack', level 1..4      1 a crack part way across, 2 all the way with a chip out,
//                                  3 split a little with light inside, 4 ready: wider, eyes peek
//                                  (p1..p4); `rock` rocks it on its foot (p4 gently, rock hard)
//   stage 'burst', b 0..1          the top lifts and tips, light pours out in rays          (burst)
//   stage 'tumble', p 0..1         the top breaks in two, each half flies out its own side  (tumble)
//   stage 'open'                   the bottom half, the halves on the ground, the bits      (open)
//
// Materials: `glow` the light inside, `star` a night egg's stars, `peek` the eyes in the chip.
export const size = { w: 104, h: 96 }

const CX = 52, CY = 58, R = 22, TOP = 35, BOT = 23 // a taller dome over a rounder base
const FOOT = CY + BOT
const shell = (x, y) => (y < CY ? ellipse(CX, CY, R, TOP) : ellipse(CX, CY, R, BOT))(x, y)

// A repeatable scatter of soft round spots, `density` of the cells of a `cell`-unit grid holding one.
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s) }
function spots(cell, radius, density) {
  return (x, y) => {
    const i = Math.floor(x / cell), j = Math.floor(y / cell)
    let best = 0
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const a = i + di, b = j + dj
        if (hash(a, b) > density) continue
        const px = (a + 0.2 + 0.6 * hash(b, a)) * cell, py = (b + 0.2 + 0.6 * hash(a + 7, b + 3)) * cell
        const r = radius * (0.6 + 0.8 * hash(a + 1, b + 5))
        best = Math.max(best, Math.max(0, 1 - Math.hypot(x - px, y - py) / r))
      }
    }
    return Math.min(1, best * 2.2)
  }
}
const tri = (v) => Math.abs((((v % 2) + 2) % 2) - 1) // a triangle wave, 0 to 1 and back every 2

// Each kind's shell: its brightness and its pattern (a multiplier on the brightness).
export const KINDS = {
  first: { tone: 0.9, tex: () => 1 }, // plain cream: the one everybody gets
  turn: { tone: 0.86, tex: (() => { const s = spots(9, 2.2, 0.22); return (x, y) => 1 - 0.5 * s(x, y) })() }, // a few freckles
  setup: { tone: 0.8, tex: (x, y) => (Math.abs(x - CX) < 3.6 || Math.abs(y - (CY - 6)) < 3.6 ? 1.3 : 0.9) }, // tied with a ribbon
  week: { tone: 0.9, tex: (() => { const s = spots(8, 3.2, 0.55); return (x, y) => 1 - 0.75 * s(x, y) })() }, // a robin's egg, speckled
  marathon: { tone: 0.9, tex: (x, y) => (Math.floor((y + 2) / 8) % 2 ? 1 : 0.45) }, // banded like a running vest
  night: { tone: 0.5, tex: () => 1, stars: true }, // dark, with stars
  easter: { tone: 0.9, tex: (x, y) => { // two painted zigzag bands
    const z = y - (CY - 14) - 5 * tri(x / 6), z2 = y - (CY + 4) - 5 * tri(x / 6 + 1)
    return (z > 0 && z < 6) || (z2 > 0 && z2 < 6) ? 0.42 : 1
  } },
  history: { tone: 0.8, tex: (x, y) => { // a band of punched-tape holes
    const band = Math.abs(y - (CY - 4)) < 5, notch = band && Math.floor(x / 4) % 2
    return band ? (notch ? 0.45 : 1.25) : 1
  } },
}
const STARS = [[38, 40], [59, 34], [48, 55], [64, 60], [35, 66], [54, 74], [43, 29], [68, 47]]

// The crack: big jagged teeth a third of the way down, from one side of the shell to the other.
const CRACK_Y = CY - 15, ZA = 4.5, ZP = 8
const zig = (x) => CRACK_Y + ZA * (tri((x - CX) / ZP + 0.25) - 0.5) * 2
const HALF = R * Math.sqrt(1 - (15 / TOP) ** 2) // the shell's half-width at the crack
const HINGE = [CX + HALF, CRACK_Y] // where the top tips from as it lifts
const CHIP = [CX - 7, CRACK_Y - 3.5] // the chip knocked out of the top, where the eyes peek
const LAND_Y = 30 // how far the halves of the top fall, to land on the ground

// A shape (or texture) moved: turned by `a` about (px, py), then shifted by (dx, dy).
function moved(f, dx, dy, a, px, py) {
  const c = Math.cos(a), s = Math.sin(a)
  return (x, y) => { const ux = x - dx - px, uy = y - dy - py; return f(px + ux * c + uy * s, py - ux * s + uy * c) }
}
const ease = (p) => p * p * (3 - 2 * p)

export function model({ t = 0, kind = 'first', stage = 'rest', level = 0, b = 0, p = 0, rock = 0 } = {}) {
  const k = KINDS[kind] ?? KINDS.first
  const lean = stage === 'crack' && rock ? rock * Math.sin(t) : stage === 'burst' ? 0.03 * Math.sin(t * 5) : 0
  const breath = stage === 'rest' ? 1 + 0.012 * Math.sin(t) : 1
  const body = (x, y) => shell(CX + (x - CX) / breath, FOOT + (y - FOOT) / breath) * breath
  const all = (f) => moved(f, 0, 0, lean, CX, FOOT) // the whole egg rocks on its foot
  const shellPart = (d, tex = k.tex) => part(all(d), { relief: 9, tone: k.tone, tex: all(tex) })
  const dark = (d) => part(all(d), { tone: 0.02, ink: false })
  const light = (d, mat = 'glow') => part(all(d), { tone: 1, mat, ink: false })
  // A night egg's stars, on whatever piece of shell they fall on (moved with it).
  const starsOn = (shape, at = (g) => g) => (k.stars ? STARS.map(([x, y], i) => {
    const r = i % 3 === 0 ? 2.4 : 1.6
    const star = union(seg(x - r, y, x + r, y, 0.55), seg(x, y - r * 1.2, x, y + r * 1.2, 0.55))
    return part(all(at(meet(star, shape))), { tone: 1, mat: 'star', ink: false })
  }) : [])
  const parts = []

  // Whole, or cracked but still in one piece: a thick dark crack part way across (level 1), then all
  // the way with two branches and a chip knocked out (level 2).
  if (stage === 'rest' || (stage === 'crack' && level < 3)) {
    parts.push(shellPart(body), ...starsOn(body))
    if (stage === 'crack') {
      const x1 = level >= 2 ? CX + HALF : CX - HALF + HALF * 1.1
      const pts = []
      for (let x = CX - HALF - 1; x <= x1; x += 0.5) pts.push([x, zig(x)])
      parts.push(dark(meet(tube(pts, 1.5), body)))
      if (level >= 2) {
        const branches = union(seg(CX + 4, zig(CX + 4), CX + 7, zig(CX + 4) + 8, 1.1, 0.5), seg(CX - 12, zig(CX - 12), CX - 16, zig(CX - 12) - 7, 1.1, 0.5))
        parts.push(dark(meet(branches, body)), dark(meet(circle(CHIP[0], CHIP[1], 2.6), body)))
      }
    }
    return { ...size, parts }
  }

  // From here the shell is in two: the bottom, and the top that lifts, tips, tumbles and lands.
  const lower = meet(body, (x, y) => zig(x) - y)
  const upper = meet(body, (x, y) => y - zig(x))
  let lift = 0, tip = 0
  if (stage === 'crack') { lift = level === 3 ? 2.6 : 4.4; tip = level === 3 ? -0.04 : -0.1 }
  if (stage === 'burst') { lift = 4.4 + 10 * ease(b); tip = -0.1 - 0.32 * ease(b) }
  const topAt = (f) => moved(f, 0, -lift, tip, HINGE[0], HINGE[1])
  // Tumbling, the top breaks in two: each half flies out its own side in an arc, turning over, and
  // lands on its back on the ground.
  let halves = null
  if (stage === 'tumble' || stage === 'open') {
    const q = stage === 'open' ? 1 : ease(p)
    const up = -(4.4 + 12 * Math.sin(Math.PI * Math.min(1, q))) * (1 - q)
    halves = [-1, 1].map((side) => {
      const pivot = [CX + side * HALF, CRACK_Y]
      return { side, at: (f) => moved(f, side * (2 - 3 * q), up + LAND_Y * q, side * (0.1 + 2.75 * q), pivot[0], pivot[1]) }
    })
  }
  // The bottom half, with light inside it, seen through the gap.
  const mouth = meet(ellipse(CX, CRACK_Y + 2.5, HALF - 1.5, 3.4), lower)
  parts.push(shellPart(lower), ...starsOn(lower), light(mouth))
  const chipR = level >= 4 || stage !== 'crack' ? 3.6 : 2.8
  const chipped = (x, y) => Math.max(upper(x, y), -circle(CHIP[0], CHIP[1], chipR)(x, y))
  if (halves) {
    for (const h of halves) {
      const half = (x, y) => Math.max(chipped(x, y), h.side * (CX - x))
      parts.push(shellPart(h.at(half), h.at(k.tex)), ...starsOn(half, h.at))
    }
  } else parts.push(shellPart(topAt(chipped), topAt(k.tex)), ...starsOn(upper, topAt))
  if (stage === 'crack' && level >= 4) {
    // Ready: two eyes peek out of the dark chip.
    const [hx, hy] = [CHIP[0], CHIP[1] + 0.5]
    parts.push(dark(topAt(meet(circle(CHIP[0], CHIP[1], 3.6), body))))
    parts.push(light(topAt(union(circle(hx - 1.5, hy, 1.1), circle(hx + 1.6, hy, 1.1))), 'peek'))
  }
  if (stage === 'burst') {
    // Light pours out of the gap, in rays that lengthen as the top lifts.
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (i - 4) * 0.28
      const len = 6 + 24 * b * (0.7 + 0.3 * hash(i, 5))
      const x0 = CX + (i - 4) * 3.4, y0 = CRACK_Y - 1
      parts.push(light(seg(x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, 1 + 0.4 * b, 0.3)))
    }
  }
  if (halves) {
    // Bits of shell: out of the crack, up, and down onto the ground.
    const q = stage === 'open' ? 1 : ease(p)
    for (const [side, far, spin] of [[-1, 16, 0.2], [-1, 26, 0.9], [1, 12, 1.7], [-1, 8, 2.4]]) {
      const x0 = CX + side * 8, y0 = CRACK_Y
      const x = x0 + side * far * q, y = y0 - 16 * Math.sin(Math.PI * Math.min(1, q)) * (1 - q * 0.3) + (FOOT - 2 - y0) * q
      parts.push(part(ellipse(x, y, 2.4, 1.3, spin + 3 * q), { relief: 1.5, tone: k.tone, tex: () => 1 }))
    }
  }
  return { ...size, parts }
}

// Every stage a client shows, with the model inputs of each frame: p0 and p4 loop (8 frames), p1 to
// p3 hold (1), and opening an egg plays rock (8, twice), burst (6), tumble (8) and open (1).
export const STAGES = {
  p0: Array.from({ length: 8 }, (_, i) => ({ stage: 'rest', t: (i / 8) * Math.PI * 2 })),
  p1: [{ stage: 'crack', level: 1 }],
  p2: [{ stage: 'crack', level: 2 }],
  p3: [{ stage: 'crack', level: 3 }],
  p4: Array.from({ length: 8 }, (_, i) => ({ stage: 'crack', level: 4, t: (i / 8) * Math.PI * 2, rock: 0.08 })),
  rock: Array.from({ length: 8 }, (_, i) => ({ stage: 'crack', level: 4, t: (i / 8) * Math.PI * 2, rock: 0.24 })),
  burst: [0.12, 0.28, 0.45, 0.62, 0.8, 1].map((b) => ({ stage: 'burst', b, t: b * 9 })),
  tumble: [0.08, 0.2, 0.34, 0.48, 0.62, 0.76, 0.9, 1].map((p) => ({ stage: 'tumble', p })),
  open: [{ stage: 'open' }],
}
