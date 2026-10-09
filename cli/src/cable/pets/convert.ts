import { ALPHA_OPAQUE, resolvePetRows, type PetRow, type PetRows, type PetSheet, type RgbaFrame } from './sheet.js'

// One frame of the pack: `cols` x `rows` palette indices, each drawn as a `cell` px square (0 = transparent).
export interface IndexedFrame {
  cols: number
  rows: number
  cell: number
  cells: Uint8Array
}

// A large scene: frame indices into ConvertedPet.frames, one per step.
export interface PetScene {
  frames: number[]
  stepMs: number
  dx: number
  dy: number
}

export interface ConvertedPet {
  palette: number[] // RGB565 in panel order (byte-swapped); palette[0] is unused (transparent)
  frames: IndexedFrame[]
  // The resting pet (rest, recap, small question): one frame pool with a loop per state. w x h is the 1x size, the
  // frames are drawn at 2x.
  small: { w: number; h: number; loops: Record<'idle' | 'done' | 'asking', number[]> }
  working: PetScene
  listening: PetScene
  sending: PetScene
  failed: PetScene
  /** Pack version 2: the scene a dial plays while it relaxes. */
  relaxing: PetScene
  warnings: string[]
}

export const STEP_MS = 120
export const SOFT_EDGE_WARNING = 'Soft edges will look jagged on the dial'

// The 2x art of a petdex pet is 192 x 208; the small resting pet is that art fitted into this box (the dial's
// 1x slot is half of it, ht_pet_t.w/h).
const ART_W = 192
const ART_H = 208
const SMALL_BOX_W = 150
const SMALL_BOX_H = 112
// The firmware's loop room (HT_PET_STEPS).
const LOOP_STEPS = 24
const IDLE_CYCLES = 3 // rest cycles before one waving pass
// 254, not 255: the pack stores the entry count (index 0 included) in one byte.
const MAX_COLOURS = 254
const SOFT_EDGE_SHARE = 0.02

function opaque(data: Uint8Array, i: number): boolean {
  return data[i + 3] >= ALPHA_OPAQUE
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

// The largest k (a divisor of both cell sides) for which every k x k block of every frame is one colour, with
// opacity judged by the dial's alpha test; 1 otherwise. A pixel-art pet drawn at 4x then becomes cells of 4 px.
export function pixelArtFactor(frames: RgbaFrame[]): number {
  if (frames.length === 0) return 1
  const { width: w, height: h } = frames[0]
  const g = gcd(w, h)
  for (let k = g; k > 1; k--) {
    if (g % k !== 0) continue
    if (frames.every((f) => f.width === w && f.height === h && uniformBlocks(f, k))) return k
  }
  return 1
}

function uniformBlocks(f: RgbaFrame, k: number): boolean {
  const { width: w, height: h, data } = f
  for (let by = 0; by < h; by += k) {
    for (let bx = 0; bx < w; bx += k) {
      const o = (by * w + bx) * 4
      const solid = opaque(data, o)
      for (let y = 0; y < k; y++) {
        for (let x = 0; x < k; x++) {
          const i = ((by + y) * w + bx + x) * 4
          if (opaque(data, i) !== solid) return false
          if (solid && (data[i] !== data[o] || data[i + 1] !== data[o + 1] || data[i + 2] !== data[o + 2])) return false
        }
      }
    }
  }
  return true
}

// Opaque edge pixels (an opaque pixel with a transparent 4-neighbour) that carry partial alpha, over all of them.
function softEdgeShare(f: RgbaFrame): number {
  const { width: w, height: h, data } = f
  let edge = 0
  let partial = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (!opaque(data, i)) continue
      const touches =
        (x > 0 && !opaque(data, i - 4)) ||
        (x < w - 1 && !opaque(data, i + 4)) ||
        (y > 0 && !opaque(data, i - w * 4)) ||
        (y < h - 1 && !opaque(data, i + w * 4))
      if (!touches) continue
      edge++
      if (data[i + 3] < 255) partial++
    }
  }
  return edge === 0 ? 0 : partial / edge
}

function rgb565(r: number, g: number, b: number): number {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)
}

// What ht_cell_frame_t palettes hold: the panel takes the two bytes swapped.
export function panelOrder(v: number): number {
  return ((v << 8) | (v >> 8)) & 0xffff
}

export function expand565(v: number): [number, number, number] {
  const r = (v >> 11) & 31
  const g = (v >> 5) & 63
  const b = v & 31
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]
}

interface Palette {
  entries565: number[] // index 0 unused
  indexOf: Int16Array // by RGB565 key; -1 = not mapped yet
}

// Median cut over the distinct RGB565 colours of every opaque pixel, weighted by how often each occurs. Working on
// 565 keys (the dial's own precision) bounds the work by 65 536 colours however large the sheet is, and a pet
// with <= 255 colours is kept exactly.
function buildPalette(sources: RgbaFrame[], k: number): Palette {
  const count = new Float64Array(65536)
  const sum = [new Float64Array(65536), new Float64Array(65536), new Float64Array(65536)]
  for (const f of sources) {
    for (let y = 0; y < f.height; y += k) {
      for (let x = 0; x < f.width; x += k) {
        const i = (y * f.width + x) * 4
        if (!opaque(f.data, i)) continue
        const r = f.data[i]
        const g = f.data[i + 1]
        const b = f.data[i + 2]
        const key = rgb565(r, g, b)
        count[key]++
        sum[0][key] += r
        sum[1][key] += g
        sum[2][key] += b
      }
    }
  }
  const keys: number[] = []
  for (let key = 0; key < 65536; key++) if (count[key] > 0) keys.push(key)
  const chan = (key: number, c: number) => expand565(key)[c]
  const order = Uint32Array.from(keys)
  const boxes: { lo: number; hi: number }[] = [{ lo: 0, hi: order.length }]
  const rangeOf = (b: { lo: number; hi: number }) => {
    const min = [255, 255, 255]
    const max = [0, 0, 0]
    for (let i = b.lo; i < b.hi; i++) {
      const e = expand565(order[i])
      for (let c = 0; c < 3; c++) {
        if (e[c] < min[c]) min[c] = e[c]
        if (e[c] > max[c]) max[c] = e[c]
      }
    }
    let best = 0
    for (let c = 1; c < 3; c++) if (max[c] - min[c] > max[best] - min[best]) best = c
    return { channel: best, span: max[best] - min[best] }
  }
  while (boxes.length < MAX_COLOURS) {
    let pick = -1
    let pickSpan = 0
    let pickChannel = 0
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      if (b.hi - b.lo < 2) continue
      const { channel, span } = rangeOf(b)
      if (span > pickSpan) {
        pick = i
        pickSpan = span
        pickChannel = channel
      }
    }
    if (pick < 0) break
    const b = boxes[pick]
    order.subarray(b.lo, b.hi).sort((p, q) => chan(p, pickChannel) - chan(q, pickChannel))
    let total = 0
    for (let i = b.lo; i < b.hi; i++) total += count[order[i]]
    let acc = 0
    let cut = b.lo + 1
    for (let i = b.lo; i < b.hi - 1; i++) {
      acc += count[order[i]]
      cut = i + 1
      if (acc * 2 >= total) break
    }
    boxes.splice(pick, 1, { lo: b.lo, hi: cut }, { lo: cut, hi: b.hi })
  }
  const entries565 = [0]
  const indexOf = new Int16Array(65536).fill(-1)
  for (const b of boxes) {
    let n = 0
    const s = [0, 0, 0]
    for (let i = b.lo; i < b.hi; i++) {
      const key = order[i]
      n += count[key]
      for (let c = 0; c < 3; c++) s[c] += sum[c][key]
    }
    if (n === 0) continue
    entries565.push(rgb565(Math.round(s[0] / n), Math.round(s[1] / n), Math.round(s[2] / n)))
    for (let i = b.lo; i < b.hi; i++) indexOf[order[i]] = entries565.length - 1
  }
  return { entries565, indexOf }
}

// The palette index of a colour; a colour no frame had (a scaled-down mix) takes the nearest entry.
function nearest(p: Palette, r: number, g: number, b: number): number {
  const key = rgb565(r, g, b)
  if (p.indexOf[key] >= 0) return p.indexOf[key]
  let best = 1
  let bestD = Infinity
  for (let i = 1; i < p.entries565.length; i++) {
    const [pr, pg, pb] = expand565(p.entries565[i])
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  p.indexOf[key] = best
  return best
}

// A frame at its pixel-art resolution: every k-th pixel, since each k x k block is one colour. `cell` is what one
// of those cells is drawn as on the dial: k, times the factor that brings a half-size sheet back to the 192 x 208 px
// the scenes are laid out for.
function indexFrame(f: RgbaFrame, k: number, cell: number, p: Palette): IndexedFrame {
  const cols = f.width / k
  const rows = f.height / k
  const cells = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * k * f.width + x * k) * 4
      if (opaque(f.data, i)) cells[y * cols + x] = nearest(p, f.data[i], f.data[i + 1], f.data[i + 2])
    }
  }
  return { cols, rows, cell, cells }
}

// A frame resampled to cols x rows cells drawn at 1 px: the small pet's frames are the 2x picture (2w x 2h) and the
// dial shows them at 1x..2x with ht_cell_sprite_zoom, exactly as the built-in pets' (gen_pets.py CELL_PETS).
// Pixel art whose factor is even is sampled at the nearest pixel (its hard edges stay hard); anything else is
// box-filtered. Either way a cell is opaque when at least half of what it covers is.
function scaleFrame(f: RgbaFrame, cols: number, rows: number, nearestSample: boolean, p: Palette): IndexedFrame {
  const cells = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (nearestSample) {
        const sx = Math.min(f.width - 1, Math.floor(((x + 0.5) * f.width) / cols))
        const sy = Math.min(f.height - 1, Math.floor(((y + 0.5) * f.height) / rows))
        const i = (sy * f.width + sx) * 4
        if (opaque(f.data, i)) cells[y * cols + x] = nearest(p, f.data[i], f.data[i + 1], f.data[i + 2])
        continue
      }
      const x0 = Math.floor((x * f.width) / cols)
      const x1 = Math.max(x0 + 1, Math.ceil(((x + 1) * f.width) / cols))
      const y0 = Math.floor((y * f.height) / rows)
      const y1 = Math.max(y0 + 1, Math.ceil(((y + 1) * f.height) / rows))
      let n = 0
      let solid = 0
      let r = 0
      let g = 0
      let b = 0
      for (let sy = y0; sy < Math.min(y1, f.height); sy++) {
        for (let sx = x0; sx < Math.min(x1, f.width); sx++) {
          const i = (sy * f.width + sx) * 4
          n++
          if (!opaque(f.data, i)) continue
          solid++
          r += f.data[i]
          g += f.data[i + 1]
          b += f.data[i + 2]
        }
      }
      if (solid * 2 >= n && solid > 0) {
        cells[y * cols + x] = nearest(p, Math.round(r / solid), Math.round(g / solid), Math.round(b / solid))
      }
    }
  }
  return { cols, rows, cell: 1, cells }
}

// `choice` is which row plays which state (resolvePetRows: the defaults fill what it leaves out). Without one, a
// petdex sheet gives exactly the pack it always has.
export function convertPet(sheet: PetSheet, choice?: Partial<PetRows>): ConvertedPet {
  const rows = sheet.rows
  const chosen = resolvePetRows(sheet, choice)
  const sceneRows: Record<'working' | 'listening' | 'sending' | 'failed' | 'relaxing', PetRow> = {
    working: chosen.working,
    listening: chosen.listening,
    sending: chosen.sending,
    failed: rows.failed.length > 0 ? 'failed' : chosen.rest,
    relaxing: chosen.relaxing,
  }
  // The rest loop waves once every few cycles only when it is petdex's idle row, the one the waving row answers.
  const waves = chosen.rest === 'idle'
  const smallRows: PetRow[] = [chosen.rest, ...(waves ? ['waving' as const] : []), chosen.asking]

  // Every frame the pack will draw, once each: the factor, the palette and the warnings are about these.
  const used = new Set<RgbaFrame>()
  for (const name of Object.values(sceneRows)) for (const f of rows[name]) used.add(f)
  for (const name of smallRows) for (const f of rows[name]) used.add(f)
  const sources = [...used]

  const k = pixelArtFactor(sources)
  const sceneCell = Math.max(1, Math.round((k * ART_W) / sheet.cellW))
  const palette = buildPalette(sources, k)
  const warnings: string[] = []
  if (sources.some((f) => softEdgeShare(f) > SOFT_EDGE_SHARE)) warnings.push(SOFT_EDGE_WARNING)

  // De-duplicated by content, so a scene that falls back to the rest row points at its frames.
  const frames: IndexedFrame[] = []
  const seen = new Map<string, number>()
  const add = (fr: IndexedFrame): number => {
    const key = `${fr.cols}x${fr.rows}x${fr.cell}:${Buffer.from(fr.cells).toString('latin1')}`
    let at = seen.get(key)
    if (at === undefined) {
      at = frames.length
      frames.push(fr)
      seen.set(key, at)
    }
    return at
  }
  const full = new Map<RgbaFrame, number>()
  const fullIndex = (f: RgbaFrame): number => {
    let at = full.get(f)
    if (at === undefined) {
      at = add(indexFrame(f, k, sceneCell, palette))
      full.set(f, at)
    }
    return at
  }
  const scene = (name: PetRow): PetScene => ({
    frames: rows[name].map(fullIndex),
    stepMs: STEP_MS,
    dx: 0,
    dy: 0,
  })

  // The small pet: the 2x art fitted into 150 x 112, half of which is the 1x size (small.w x small.h). Its frames
  // are the 2x picture itself, 2w x 2h cells of 1 px.
  const fit = Math.min(SMALL_BOX_W / ART_W, SMALL_BOX_H / ART_H)
  const smallW = Math.floor((ART_W * fit) / 2)
  const smallH = Math.floor((ART_H * fit) / 2)
  const small = new Map<RgbaFrame, number>()
  const smallIndex = (f: RgbaFrame): number => {
    let at = small.get(f)
    if (at === undefined) {
      at = add(scaleFrame(f, smallW * 2, smallH * 2, k % 2 === 0, palette))
      small.set(f, at)
    }
    return at
  }
  const idle = rows[chosen.rest].map(smallIndex)
  const wave = waves ? rows.waving.map(smallIndex) : []
  let cycles = IDLE_CYCLES
  while (cycles > 1 && idle.length * cycles + wave.length > LOOP_STEPS) cycles--
  const idleLoop: number[] = []
  for (let c = 0; c < cycles; c++) idleLoop.push(...idle)
  idleLoop.push(...wave)

  const working = scene(sceneRows.working)
  const listening = scene(sceneRows.listening)
  const sending = scene(sceneRows.sending)
  const failed = scene(sceneRows.failed)
  const pet: ConvertedPet = {
    palette: palette.entries565.map((v, i) => (i === 0 ? 0 : panelOrder(v))),
    frames,
    small: {
      w: smallW,
      h: smallH,
      loops: {
        idle: idleLoop.slice(0, LOOP_STEPS),
        done: idle.slice(0, LOOP_STEPS),
        asking: rows[chosen.asking].map(smallIndex).slice(0, LOOP_STEPS),
      },
    },
    working,
    listening,
    sending,
    failed,
    relaxing: { frames: [], stepMs: STEP_MS, dx: 0, dy: 0 },
    warnings,
  }
  // Last, so the frames only this scene uses come after every other: a version 1 pack leaves them out (encodePack).
  pet.relaxing = scene(chosen.relaxing)
  return pet
}
