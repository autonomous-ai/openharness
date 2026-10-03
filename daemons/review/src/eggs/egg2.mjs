import { ellipse, circle, tube, part, seg, meet, union } from './plate.mjs'

// The egg, cracked so it reads: a thick jagged crack that splits the shell as you earn it, a gap
// with light inside, a chip with two eyes peeking out when it is ready; opened, the light bursts in
// the rarity's colour, the top tumbles off and lands beside it, and bits of shell scatter.
//
//   stage 'rest'                 whole, breathing
//   stage 'crack', level 1..4    1 a crack part way across, 2 all the way with a chip out,
//                                3 split open a little, light inside, 4 ready: wider, eyes peek
//   stage 'burst', b 0..1        the top lifts and tips, light pours out
//   stage 'tumble', p 0..1       the top flies off in an arc and lands on its side; bits scatter
//   stage 'open'                 the bottom half, the top on the ground beside it, the bits
export const size = { w: 104, h: 96 }

const CX = 52, CY = 58, R = 22, TOP = 35, BOT = 23
const FOOT = CY + BOT
const shell = (x, y) => (y < CY ? ellipse(CX, CY, R, TOP) : ellipse(CX, CY, R, BOT))(x, y)

const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s) }
function spots(cell, radius, density) {
  return (x, y) => {
    const i = Math.floor(x / cell), j = Math.floor(y / cell)
    let best = 0
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const a = i + di, b = j + dj
      if (hash(a, b) > density) continue
      const px = (a + 0.2 + 0.6 * hash(b, a)) * cell, py = (b + 0.2 + 0.6 * hash(a + 7, b + 3)) * cell
      const r = radius * (0.6 + 0.8 * hash(a + 1, b + 5))
      best = Math.max(best, Math.max(0, 1 - Math.hypot(x - px, y - py) / r))
    }
    return Math.min(1, best * 2.2)
  }
}
const tri = (v) => Math.abs(((v % 2) + 2) % 2 - 1)

export const KINDS = {
  first: { tone: 0.9, tex: () => 1 },
  turn: { tone: 0.86, tex: (() => { const s = spots(9, 2.2, 0.22); return (x, y) => 1 - 0.5 * s(x, y) })() },
  setup: { tone: 0.8, tex: (x, y) => (Math.abs(x - CX) < 3.6 || Math.abs(y - (CY - 6)) < 3.6 ? 1.3 : 0.9) },
  week: { tone: 0.9, tex: (() => { const s = spots(8, 3.2, 0.55); return (x, y) => 1 - 0.75 * s(x, y) })() },
  marathon: { tone: 0.9, tex: (x, y) => (Math.floor((y + 2) / 8) % 2 ? 1 : 0.45) },
  night: { tone: 0.5, tex: () => 1, stars: true },
  easter: { tone: 0.9, tex: (x, y) => { const z = y - (CY - 14) - 5 * tri(x / 6); const z2 = y - (CY + 4) - 5 * tri(x / 6 + 1); return (z > 0 && z < 6) || (z2 > 0 && z2 < 6) ? 0.42 : 1 } },
  history: { tone: 0.8, tex: (x, y) => { const band = Math.abs(y - (CY - 4)) < 5; const notch = band && Math.floor(x / 4) % 2; return band ? (notch ? 0.45 : 1.25) : 1 } },
}
const STARS = [[38, 40], [59, 34], [48, 55], [64, 60], [35, 66], [54, 74], [43, 29], [68, 47]]

// The crack: big jagged teeth a third of the way down.
const CRACK_Y = CY - 15, ZA = 4.5, ZP = 8
const zig = (x) => CRACK_Y + ZA * (tri((x - CX) / ZP + 0.25) - 0.5) * 2
const HALF = R * Math.sqrt(1 - (15 / TOP) ** 2)        // the shell's half-width at the crack
const HINGE = [CX + HALF, CRACK_Y]
const CHIP = [CX - 7, CRACK_Y - 3.5]

// A shape (or texture) moved: turned by `a` about (px, py), then shifted by (dx, dy).
function moved(f, dx, dy, a, px, py) {
  const c = Math.cos(a), s = Math.sin(a)
  return (x, y) => { const ux = x - dx - px, uy = y - dy - py; return f(px + ux * c + uy * s, py - ux * s + uy * c) }
}
const ease = (p) => p * p * (3 - 2 * p)
const LAND_Y = 30   // how far the lid halves fall, to rest on the ground

export function model({ t = 0, kind = 'first', stage = 'rest', level = 0, b = 0, p = 0, rock = 0 } = {}) {
  const k = KINDS[kind] ?? KINDS.first
  const lean = stage === 'crack' && rock ? rock * Math.sin(t) : stage === 'burst' ? 0.03 * Math.sin(t * 5) : 0
  const breath = stage === 'rest' ? 1 + 0.012 * Math.sin(t) : 1
  const body = (x, y) => shell(CX + (x - CX) / breath, FOOT + (y - FOOT) / breath) * breath
  const all = (f) => moved(f, 0, 0, lean, CX, FOOT)      // the whole egg rocks on its foot
  const shellPart = (d, tex = k.tex, o = {}) => part(all(d), { relief: 9, tone: k.tone, tex: all(tex), ...o })
  const dark = (d) => part(all(d), { tone: 0.02, ink: false })
  const light = (d, mat = 'glow') => part(all(d), { tone: 1, mat, ink: false })
  const starsOn = (shape, f = (g) => g) => (k.stars ? STARS.map(([x, y], i) => {
    const r = i % 3 === 0 ? 2.4 : 1.6
    return part(all(f(meet(union(seg(x - r, y, x + r, y, 0.55), seg(x, y - r * 1.2, x, y + r * 1.2, 0.55)), shape))), { tone: 1, mat: 'star', ink: false })
  }) : [])
  const parts = []

  if (stage === 'rest' || (stage === 'crack' && level < 3)) {
    parts.push(shellPart(body), ...starsOn(body))
    if (stage === 'crack') {
      // a thick dark crack, part way across at level 1, all the way with branches at 2
      const x1 = level >= 2 ? CX + HALF : CX - HALF + HALF * 1.1
      const pts = []
      for (let x = CX - HALF - 1; x <= x1; x += 0.5) pts.push([x, zig(x)])
      parts.push(dark(meet(tube(pts, 1.5), body)))
      if (level >= 2) {
        parts.push(dark(meet(union(seg(CX + 4, zig(CX + 4), CX + 7, zig(CX + 4) + 8, 1.1, 0.5), seg(CX - 12, zig(CX - 12), CX - 16, zig(CX - 12) - 7, 1.1, 0.5)), body)))
        parts.push(dark(meet(circle(CHIP[0], CHIP[1], 2.6), body)))   // a chip knocked out
      }
    }
    return { ...size, parts }
  }

  // From here the shell is in two: the bottom, and the top that lifts, tips, tumbles and lands.
  const lower = meet(body, (x, y) => zig(x) - y)
  const upperShape = meet(body, (x, y) => y - zig(x))
  let lift = 0, tip = 0, dx = 0
  if (stage === 'crack') { lift = level === 3 ? 2.6 : 4.4; tip = level === 3 ? -0.04 : -0.1 }
  if (stage === 'burst') { lift = 4.4 + 10 * ease(b); tip = -0.1 - 0.32 * ease(b) }
  let upperAt = (f) => moved(f, dx, -lift, tip, HINGE[0], HINGE[1])
  // Tumbling, the top breaks in two: each half flies out its own side in an arc, turning over,
  // and lands on its back on the ground.
  let halves = null
  if (stage === 'tumble' || stage === 'open') {
    const q = stage === 'open' ? 1 : ease(p)
    const up = -(4.4 + 12 * Math.sin(Math.PI * Math.min(1, q))) * (1 - q)
    halves = [-1, 1].map((side) => {
      const pivot = [CX + side * HALF, CRACK_Y]
      const x = side * (2 - 3 * q), y = up + LAND_Y * q
      return { side, at: (f) => moved(f, x, y, side * (0.1 + 2.75 * q), pivot[0], pivot[1]) }
    })
  }
  // inside the bottom half: light, seen through the gap
  const mouth = meet(ellipse(CX, CRACK_Y + 2.5, HALF - 1.5, 3.4), lower)
  parts.push(shellPart(lower), ...starsOn(lower))
  if (stage !== 'open' || true) parts.push(light(mouth))
  const chipR = level >= 4 || stage !== 'crack' ? 3.6 : 2.8
  const withChip = (x, y) => Math.max(upperShape(x, y), -circle(CHIP[0], CHIP[1], chipR)(x, y))
  if (halves) {
    for (const h of halves) {
      const half = (x, y) => Math.max(withChip(x, y), h.side * (CX - x))
      parts.push(shellPart(h.at(half), h.at(k.tex)), ...starsOn(half, h.at))
    }
  } else parts.push(shellPart(upperAt(withChip), upperAt(k.tex)), ...starsOn(upperShape, upperAt))
  if (stage === 'crack' && level >= 4) {
    // two eyes peek out of the chip
    const [hx, hy] = [CHIP[0], CHIP[1] + 0.5]
    const peek = union(circle(hx - 1.5, hy, 1.1), circle(hx + 1.6, hy, 1.1))
    parts.push(dark(upperAt(meet(circle(CHIP[0], CHIP[1], 3.6), body))))
    parts.push(light(upperAt(peek), 'peek'))
  }
  if (stage === 'burst') {
    // light pours out of the gap, in rays
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 + (i - 4) * 0.28
      const len = 6 + 24 * b * (0.7 + 0.3 * hash(i, 5))
      const x0 = CX + (i - 4) * 3.4, y0 = CRACK_Y - 1
      parts.push(light(seg(x0, y0, x0 + Math.cos(a) * len, y0 + Math.sin(a) * len, 1 + 0.4 * b, 0.3)))
    }
  }
  if (stage === 'tumble' || stage === 'open') {
    // bits of shell: out of the crack, onto the ground
    const q = stage === 'open' ? 1 : ease(p)
    const BITS = [[-1, 16, 0.2], [-1, 26, 0.9], [1, 12, 1.7], [-1, 8, 2.4]]
    for (const [side, far, spin] of BITS) {
      const x0 = CX + side * 8, y0 = CRACK_Y
      const x = x0 + side * far * q, y = y0 - 16 * Math.sin(Math.PI * Math.min(1, q)) * (1 - q * 0.3) + (FOOT - 2 - y0) * q
      parts.push(part(ellipse(x, y, 2.4, 1.3, spin + 3 * q), { relief: 1.5, tone: k.tone, tex: () => 1 }))
    }
  }
  return { ...size, parts }
}
