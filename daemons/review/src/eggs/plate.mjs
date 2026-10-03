// Plates: drop 3's filled art, in the line-printer tradition (the density ramp of the Mona Lisa
// printouts). A drop-3 daemon is a model made of shapes, not a drawing: plate() shades the model
// into characters at any size, so one model gives the portrait, the reveal and every animation
// frame. Dense characters read as light on a dark screen; `paper: true` inverts for ink on paper.
//
// Models are drawn on a canvas of square units, y down (like SVG). A terminal cell is about twice
// as tall as it is wide, so a canvas w by h renders to cols by round(cols * h / (2 * w)) rows.

// Each glyph with the brightness it gives six regions of its cell:
// top-left, top-right, middle-left, middle-right, bottom-left, bottom-right.
const GLYPHS = [
  [' ', [0, 0, 0, 0, 0, 0]],
  ['.', [0, 0, 0, 0, 0.22, 0.22]],
  [',', [0, 0, 0, 0.06, 0.3, 0.24]],
  [':', [0.14, 0.14, 0.1, 0.1, 0.16, 0.16]],
  [';', [0.12, 0.12, 0.16, 0.16, 0.3, 0.26]],
  ['o', [0.02, 0.02, 0.4, 0.4, 0.38, 0.38]],
  ['x', [0.06, 0.06, 0.5, 0.5, 0.5, 0.5]],
  ['%', [0.46, 0.46, 0.56, 0.56, 0.5, 0.5]],
  ['#', [0.7, 0.7, 0.76, 0.76, 0.7, 0.7]],
  ['@', [0.92, 0.92, 0.96, 0.96, 0.92, 0.92]],
]
const SAME_DENSITY = { ':': ';' } // swapped in to break a ligature pair

// ---- shapes: signed distance, negative inside ----------------------------------------------

export const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r

export function ellipse(cx, cy, rx, ry, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot), m = Math.min(rx, ry)
  return (x, y) => {
    const dx = x - cx, dy = y - cy
    const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry
    return (Math.hypot(u, v) - 1) * m
  }
}

export function box(cx, cy, hw, hh, round = 0, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot)
  return (x, y) => {
    const dx = x - cx, dy = y - cy
    const u = Math.abs(dx * c + dy * s) - hw + round, v = Math.abs(-dx * s + dy * c) - hh + round
    return Math.hypot(Math.max(u, 0), Math.max(v, 0)) + Math.min(Math.max(u, v), 0) - round
  }
}

// A segment whose radius runs from ra to rb (iq's uneven capsule).
export function seg(ax, ay, bx, by, ra, rb = ra) {
  const px = bx - ax, py = by - ay, h = px * px + py * py
  if (h < 1e-9) return circle(ax, ay, Math.max(ra, rb))
  const b = ra - rb, cx = Math.sqrt(Math.max(h - b * b, 1e-9)), cy = b
  return (x, y) => {
    const qx0 = x - ax, qy0 = y - ay
    const qx = Math.abs((qx0 * py - qy0 * px) / h), qy = (qx0 * px + qy0 * py) / h
    const k = cx * qy - cy * qx, m = cx * qx + cy * qy, n = qx * qx + qy * qy
    if (k < 0) return Math.sqrt(h * n) - ra
    if (k > cx) return Math.sqrt(h * (n + 1 - 2 * qy)) - rb
    return m - ra
  }
}

// A tube along points, its radius eased from r0 to r1.
export function tube(points, r0, r1 = r0) {
  const lens = [0]
  for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))
  const total = lens[lens.length - 1] || 1
  const r = (l) => r0 + (r1 - r0) * (l / total)
  const parts = []
  for (let i = 1; i < points.length; i++) parts.push(seg(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], r(lens[i - 1]), r(lens[i])))
  return union(...parts)
}

// Points along a path that starts at (x, y) heading `angle` (radians, 0 = right, y down) and turns
// by `bend(u)` radians per unit of length, u running 0..1 along it: arms, tails, horns, curls.
export function path(x, y, angle, length, bend = () => 0, steps = 28) {
  const pts = [[x, y]], ds = length / steps
  let a = angle
  for (let i = 1; i <= steps; i++) {
    a += bend((i - 0.5) / steps) * ds
    x += Math.cos(a) * ds
    y += Math.sin(a) * ds
    pts.push([x, y])
  }
  return pts
}

export const union = (...ds) => (x, y) => { let m = Infinity; for (const d of ds) m = Math.min(m, d(x, y)); return m }
export const cut = (a, ...bs) => (x, y) => { let m = a(x, y); for (const b of bs) m = Math.max(m, -b(x, y)); return m }
export const meet = (a, b) => (x, y) => Math.max(a(x, y), b(x, y))
export function blend(k, ...ds) {
  return (x, y) => {
    let m = ds[0](x, y)
    for (let i = 1; i < ds.length; i++) {
      const b = ds[i](x, y), h = Math.max(k - Math.abs(m - b), 0) / k
      m = Math.min(m, b) - h * h * k * 0.25
    }
    return m
  }
}
export const mirror = (cx, d) => (x, y) => d(cx - Math.abs(x - cx), y)

// ---- parts ---------------------------------------------------------------------------------
// A part is { d, tone = 1, relief, flat, tex, ink = true }, drawn back to front.
//   d       the shape
//   tone    its brightness, 0 to 1
//   relief  how far in the shape rises to full height (round bodies); omit for a flat part
//   tex     (x, y) => multiplier on its brightness, for fur, feathers, grain
//   ink     false to skip the dark line where it overlaps the parts behind it
export const part = (d, o = {}) => ({ d, tone: 1, ...o })

// ---- rendering -----------------------------------------------------------------------------

const LIGHT = (() => { const v = [-0.5, -0.62, 0.62], n = Math.hypot(...v); return v.map((c) => c / n) })()
const HALF = (() => { const v = [LIGHT[0], LIGHT[1], LIGHT[2] + 1], n = Math.hypot(...v); return v.map((c) => c / n) })()

// Brightness at a point, 0 to 1, or -1 where no part is. On paper every edge gets an ink line, not
// only the edges in front of other parts, because the paper itself is light.
let lastMat = null
function shader(parts, inkW, paper) {
  return (x, y) => {
    lastMat = null
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i], d = p.d(x, y)
      if (d >= 0) continue
      const s = -d
      let b = p.tone
      if (p.relief) {
        const e = 0.25
        const gx = (p.d(x + e, y) - p.d(x - e, y)) / (2 * e), gy = (p.d(x, y + e) - p.d(x, y - e)) / (2 * e)
        const gl = Math.hypot(gx, gy) || 1
        const u = Math.min(s / p.relief, 1), slope = u >= 1 ? 0 : (1 - u) / Math.sqrt(Math.max(1 - (1 - u) * (1 - u), 1e-4))
        let nx = (gx / gl) * slope, ny = (gy / gl) * slope, nz = 1
        const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl
        const lambert = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2])
        const spec = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 24)
        b = p.tone * (0.46 + 0.58 * lambert) + 0.3 * spec * p.tone
      }
      if (p.tex) b *= p.tex(x, y)
      lastMat = p.mat ?? null
      if (p.ink !== false && s < inkW) {
        let behind = false
        for (let j = i - 1; j >= 0; j--) if (parts[j].d(x, y) < 0) { behind = true; break }
        if (behind || paper) b *= 0.22
      }
      return Math.max(0, Math.min(1, b))
    }
    return -1
  }
}

// Shade a model ({ w, h, parts }) into `cols` columns. Returns the rows as strings, each exactly
// `cols` wide. `paper` prints dark ink on light paper: highlights stay bare, shadows and edges ink.
export function plate(model, cols, { paper = false, samples = 2, mats = null } = {}) {
  const rows = Math.max(1, Math.round((cols * model.h) / (2 * model.w)))
  const cw = model.w / cols, ch = model.h / rows
  const shade = shader(model.parts, cw * 0.55, paper)
  const out = []
  const matRows = []
  for (let r = 0; r < rows; r++) {
    let line = '', matLine = ''
    for (let c = 0; c < cols; c++) {
      const v = []
      const marks = {}
      let lit = 0
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          let sum = 0
          for (let j = 0; j < samples; j++) {
            for (let i = 0; i < samples; i++) {
              const x = (c + (sx + (i + 0.5) / samples) / 2) * cw
              const y = (r + (sy + (j + 0.5) / samples) / 3) * ch
              const b = shade(x, y)
              if (b >= 0) { lit++; if (lastMat) marks[lastMat] = (marks[lastMat] ?? 0) + 1 }
              sum += b < 0 ? 0 : paper ? Math.min(1, 1.08 - b) : b
            }
          }
          v.push(sum / (samples * samples))
        }
      }
      line += pick(v)
      // a cell takes a material when at least half its lit samples are that material: g glow, s star
      const [mat] = Object.entries(marks).find(([, n]) => n * 2 >= lit) ?? ['.']
      matLine += mat === '.' ? '.' : mat[0]
    }
    out.push(line)
    matRows.push(matLine)
  }
  if (mats) mats.push(...matRows)
  return unligature(out)
}

function pick(v) {
  const mean = v.reduce((a, b) => a + b, 0) / 6
  if (mean < 0.035) return ' '
  let best = ' ', cost = Infinity
  for (const [g, d] of GLYPHS) {
    let e = 0, dm = 0
    for (let i = 0; i < 6; i++) { e += (v[i] - d[i]) ** 2; dm += d[i] }
    e += 3 * (mean - dm / 6) ** 2
    if (e < cost) { cost = e; best = g }
  }
  return best
}

// The ramp only ever makes one ligature pair, "::"; the second colon becomes a semicolon.
function unligature(lines) {
  return lines.map((l) => {
    let s = ''
    for (const ch of l) s += s.endsWith(':') && ch === ':' ? SAME_DENSITY[':'] : ch
    return s
  })
}

// Crop blank rows and columns shared by every frame, so animation frames stay aligned.
export function crop(frames) {
  const all = frames.flat()
  const width = Math.max(...all.map((l) => l.length))
  let left = width, right = 0
  for (const l of all) {
    const a = l.search(/\S/)
    if (a >= 0) { left = Math.min(left, a); right = Math.max(right, l.trimEnd().length) }
  }
  const rowsOf = (f) => f.map((l) => l.slice(left, right).padEnd(right - left))
  const isBlank = (i) => frames.every((f) => !f[i].trim())
  let top = 0, bottom = frames[0].length
  while (top < bottom && isBlank(top)) top++
  while (bottom > top && isBlank(bottom - 1)) bottom--
  return frames.map((f) => rowsOf(f).slice(top, bottom))
}

// ---- eyes ----------------------------------------------------------------------------------
// One eye at (x, y) with radius r, in the roster's moods: open (idle), narrowed (work), wide
// (need, boop), happy arcs (done, back), crossed (fail), shut (nap). Marks are dark on the body;
// pupils are bright. `look` shifts the pupil (-1 to 1 in x, y), toward what changed.
export function eye(x, y, r, mood = 'idle', { look = [0, 0.2], tone = 0.08 } = {}) {
  const dark = (d) => part(d, { tone, ink: false })
  const lit = (d) => part(d, { tone: 1, ink: false })
  switch (mood) {
    case 'nap': return [dark(tube(path(x - r, y, -0.35, r * 2.1, () => 0.33 / r), r * 0.26))]
    case 'done': case 'back': return [dark(tube(path(x - r, y + r * 0.35, -1.15, r * 2.6, () => 0.88 / r), r * 0.28))]
    case 'fail': return [dark(seg(x - r * 0.8, y - r * 0.8, x + r * 0.8, y + r * 0.8, r * 0.24)), dark(seg(x - r * 0.8, y + r * 0.8, x + r * 0.8, y - r * 0.8, r * 0.24))]
    case 'work': return [dark(ellipse(x, y, r, r * 0.5)), lit(circle(x + look[0] * r * 0.3, y, r * 0.34))]
    case 'need': case 'boop': return [dark(ellipse(x, y, r * 1.2, r * 1.2)), lit(circle(x, y, r * 0.32))]
    default: return [dark(ellipse(x, y, r, r * 0.85)), lit(circle(x + look[0] * r * 0.45, y + look[1] * r * 0.45, r * 0.4))]
  }
}
