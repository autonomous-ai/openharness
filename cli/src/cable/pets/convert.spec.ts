import { describe, expect, it } from 'vitest'
import { convertPet, pixelArtFactor } from './convert.js'
import { PET_ROWS, type PetRow, type PetSheet, type RgbaFrame } from './sheet.js'

const CW = 192
const CH = 208

type Painter = (x: number, y: number) => [number, number, number, number]

function frame(paint: Painter, w = CW, h = CH): RgbaFrame {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(paint(x, y), (y * w + x) * 4)
  }
  return { width: w, height: h, data }
}

// A blob of `size` px in colour (r, g, b) in the middle of the cell.
function blob(r: number, g: number, b: number, size = 60, a = 255): Painter {
  const x0 = (CW - size) >> 1
  const y0 = (CH - size) >> 1
  return (x, y) => (x >= x0 && x < x0 + size && y >= y0 && y < y0 + size ? [r, g, b, a] : [0, 0, 0, 0])
}

function sheet(rows: Partial<Record<PetRow, RgbaFrame[]>>, cellW = CW, cellH = CH): PetSheet {
  const full = {} as Record<PetRow, RgbaFrame[]>
  for (const name of PET_ROWS) full[name] = rows[name] ?? []
  return { cellW, cellH, rows: full }
}

const simple = () =>
  sheet({
    idle: [frame(blob(200, 30, 30)), frame(blob(30, 200, 30))],
    running: [frame(blob(30, 30, 200)), frame(blob(200, 200, 30)), frame(blob(30, 200, 200))],
  })

describe('pixelArtFactor', () => {
  // 48 x 52 art, each art pixel one of 5 colours, drawn k x k px.
  const art = (k: number, w = CW, h = CH): RgbaFrame =>
    frame((x, y) => {
      const ax = Math.floor(x / k)
      const ay = Math.floor(y / k)
      return (ax + ay) % 5 === 0 ? [0, 0, 0, 0] : [40 * ((ax * 3 + ay) % 5), 90, 200 - 10 * (ax % 7), 255]
    }, w, h)

  it('4x-upscaled art → 4', () => {
    expect(pixelArtFactor([art(4), art(4)])).toBe(4)
  })

  it('photo-like → 1', () => {
    const photo = frame((x, y) => [(x * 7 + y * 3) & 255, (x * 5) & 255, (y * 11) & 255, 255])
    expect(pixelArtFactor([photo])).toBe(1)
  })

  it('factor 3 is refused when the cell is not divisible', () => {
    // 192 divides by 3 but 208 does not, so 3x art cannot be a whole number of art pixels tall.
    expect(pixelArtFactor([art(3)])).toBe(1)
  })

  it('no frames → 1', () => {
    expect(pixelArtFactor([])).toBe(1)
  })
})

describe('convertPet', () => {
  it('alpha 127 is transparent, 128 opaque', () => {
    const s = sheet({
      idle: [frame((x, y) => (x < 100 ? [255, (x * 7 + y * 13) & 255, 0, y < 100 ? 127 : 128] : [0, 0, 0, 0]))],
      running: [frame(blob(0, 0, 255))],
    })
    const pet = convertPet(s)
    const f = pet.frames[pet.listening.frames[0]]
    expect([f.cols, f.cell]).toEqual([CW, 1])
    expect(f.cells[50 * f.cols + 50]).toBe(0) // alpha 127
    expect(f.cells[150 * f.cols + 50]).not.toBe(0) // alpha 128
  })

  it('palette has <= 256 entries and index 0 is unused', () => {
    const pet = convertPet(simple())
    expect(pet.palette.length).toBeLessThanOrEqual(256)
    expect(pet.palette[0]).toBe(0)
    for (const f of pet.frames) for (const c of f.cells) expect(c).toBeLessThan(pet.palette.length)
  })

  it('RGB565 panel order', () => {
    const pet = convertPet(
      sheet({ idle: [frame(blob(255, 0, 0))], running: [frame(blob(255, 0, 0))] }),
    )
    expect(pet.palette[1]).toBe(0x00f8)
  })

  it('quantize: 40k-colour sheet → 255 colours in under 2 s', () => {
    // 200 x 200 distinct colours across 8 frames' worth of area: a gradient in two axes.
    const grad = (shift: number) =>
      frame((x, y) => (x < 180 && y < 200 ? [(x * 255) / 180, (y * 255) / 200, (shift * 40 + x + y) & 255, 255] : [0, 0, 0, 0]))
    const s = sheet({
      idle: [grad(0), grad(1), grad(2), grad(3)],
      running: [grad(4), grad(5), grad(6), grad(7)],
    })
    const t0 = performance.now()
    const pet = convertPet(s)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(2000)
    expect(pet.palette.length).toBeLessThanOrEqual(256)
    expect(pet.palette.length).toBeGreaterThan(200)
  })

  it('soft-edge warning above 2 %', () => {
    // Opaque square whose rim is alpha 200: every opaque edge pixel is partial.
    const soft: Painter = (x, y) => {
      const inside = x >= 50 && x < 150 && y >= 50 && y < 150
      const rim = inside && (x === 50 || x === 149 || y === 50 || y === 149)
      return inside ? [10, 200, 10, rim ? 200 : 255] : [0, 0, 0, 0]
    }
    const noisy = convertPet(sheet({ idle: [frame(soft)], running: [frame(blob(0, 0, 255))] }))
    expect(noisy.warnings).toContain('Soft edges will look jagged on the dial')
    expect(convertPet(simple()).warnings).not.toContain('Soft edges will look jagged on the dial')
  })

  it('review row empty → listening uses idle’s frame indices', () => {
    const pet = convertPet(simple())
    expect(pet.listening.frames).toEqual(pet.sending.frames)
    expect(pet.listening.frames).toEqual(pet.failed.frames)
    expect(pet.listening.frames.length).toBe(2)
    // Substitution adds no frames: idle (2) + running (3) at full size, small idle (2).
    expect(pet.frames.length).toBe(2 + 3 + 2)
    expect(pet.working.frames.length).toBe(3)
    expect(new Set([...pet.listening.frames, ...pet.working.frames]).size).toBe(5)
  })

  it('a filled review row gives listening its own frames', () => {
    const s = simple()
    s.rows.review = [frame(blob(1, 2, 3)), frame(blob(4, 5, 6))]
    const pet = convertPet(s)
    expect(pet.listening.frames).not.toEqual(pet.sending.frames)
  })

  it('small pet is the 2x art at cell 1: 2w x 2h cells, w x h being the 1x size (firmware ht_pet_t.cells)', () => {
    for (const [cw, ch] of [[192, 208], [96, 104]]) {
      const pet = convertPet(
        sheet({ idle: [frame(blob(9, 9, 9), cw, ch)], running: [frame(blob(9, 9, 9), cw, ch)] }, cw, ch),
      )
      expect(pet.small.w * 2).toBeLessThanOrEqual(150)
      expect(pet.small.h * 2).toBeLessThanOrEqual(112)
      expect(pet.small.w).toBeGreaterThan(40)
      for (const n of pet.small.loops.idle) {
        const f = pet.frames[n]
        expect([f.cols, f.rows, f.cell]).toEqual([pet.small.w * 2, pet.small.h * 2, 1])
      }
    }
  })

  it('the same art at half size gives scenes of the same 192 x 208 px', () => {
    const paint: Painter = (x, y) => ((x >> 3) + (y >> 3)) % 3 === 0 ? [0, 0, 0, 0] : [200, (x * 3) & 255, 40, 255]
    const half = (p: Painter): Painter => (x, y) => p(x * 2, y * 2)
    const big = convertPet(sheet({ idle: [frame(paint)], running: [frame(paint)] }))
    const small = convertPet(sheet({ idle: [frame(half(paint), 96, 104)], running: [frame(half(paint), 96, 104)] }, 96, 104))
    for (const pet of [big, small]) {
      const f = pet.frames[pet.working.frames[0]]
      expect([f.cols * f.cell, f.rows * f.cell]).toEqual([192, 208])
    }
    const f = small.frames[small.working.frames[0]]
    expect([f.cols, f.rows, f.cell]).toEqual([96, 104, 2])
    // The small resting pet is the same size either way.
    expect(small.small.w).toBe(big.small.w)
  })

  it('small loops: idle waves every fourth cycle, asking falls back to idle', () => {
    const s = simple()
    s.rows.waving = [frame(blob(9, 99, 9)), frame(blob(99, 9, 99))]
    const pet = convertPet(s)
    const idle = pet.small.loops.idle
    expect(idle.length).toBe(2 * 3 + 2)
    expect(idle.slice(0, 2)).toEqual(idle.slice(2, 4))
    expect(idle.slice(6)).not.toEqual(idle.slice(0, 2))
    expect(pet.small.loops.done).toEqual(pet.small.loops.idle.slice(0, 2))
    expect(pet.small.loops.asking).toEqual(pet.small.loops.done)
  })

  it('uses the pixel-art factor as the cell size', () => {
    const art = (k: number) =>
      frame((x, y) => {
        const ax = Math.floor(x / k)
        const ay = Math.floor(y / k)
        return ax >= 5 && ax < 40 && ay >= 5 && ay < 40 ? [30 * (ax % 8), 100, 30 * (ay % 8), 255] : [0, 0, 0, 0]
      })
    const pet = convertPet(sheet({ idle: [art(4)], running: [art(4)] }))
    const big = pet.frames.find((f) => f.cell === 4)!
    expect([big.cols, big.rows]).toEqual([48, 52])
  })

  it('explicit default rows give the same pet as no choice', () => {
    const s = simple()
    s.rows.waving = [frame(blob(9, 99, 9))]
    s.rows.review = [frame(blob(1, 2, 3))]
    expect(convertPet(s, { rest: 'idle', working: 'running', listening: 'review', sending: 'waving', asking: 'waiting' })).toEqual(convertPet(s))
  })

  it('chosen rows play their states; empty listening, sending and asking fall back to the rest row', () => {
    const s = sheet({
      jumping: [frame(blob(10, 20, 30)), frame(blob(40, 50, 60))],
      runningLeft: [frame(blob(70, 80, 90))],
      waving: [frame(blob(9, 99, 9))],
      failed: [frame(blob(200, 0, 0))],
      review: [frame(blob(0, 200, 0)), frame(blob(0, 0, 200)), frame(blob(200, 200, 200))],
    })
    const pet = convertPet(s, { rest: 'jumping', working: 'runningLeft', listening: 'review', sending: 'waiting', asking: 'idle' })
    expect(pet.working.frames.length).toBe(1)
    expect(pet.listening.frames.length).toBe(3)
    expect(pet.sending.frames.length).toBe(2) // waiting is empty: the rest row
    expect(pet.failed.frames.length).toBe(1) // the failed row, not the rest row
    // No waving pass: the rest row is not idle.
    expect(pet.small.loops.idle).toEqual([...pet.small.loops.done, ...pet.small.loops.done, ...pet.small.loops.done])
    expect(pet.small.loops.done.length).toBe(2)
    expect(pet.small.loops.asking).toEqual(pet.small.loops.done)
    // Only the frames the pack plays are in it: the waving row is not.
    expect(pet.frames.length).toBe(2 + 1 + 3 + 1 + 2)
  })

  it('an empty failed row falls back to the rest row', () => {
    const s = sheet({ jumping: [frame(blob(10, 20, 30))], running: [frame(blob(70, 80, 90))] })
    const pet = convertPet(s, { rest: 'jumping' })
    expect(pet.failed.frames).toEqual(pet.listening.frames)
  })

  it('refuses an empty chosen rest or working row', () => {
    expect(() => convertPet(simple(), { working: 'jumping' })).toThrow('The row chosen for Working is empty')
    expect(() => convertPet(simple(), { rest: 'review' })).toThrow('The row chosen for Rest is empty')
  })

  it('steps default to 120 ms', () => {
    const pet = convertPet(simple())
    expect(pet.working).toMatchObject({ stepMs: 120, dx: 0, dy: 0 })
  })
})
