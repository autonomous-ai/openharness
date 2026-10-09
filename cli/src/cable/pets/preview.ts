import { PNG } from 'pngjs'
import { expand565, panelOrder, type ConvertedPet, type IndexedFrame } from './convert.js'
import { PET_ROWS, type PetRow, type PetSheet, type RgbaFrame } from './sheet.js'

const SMALL_STEP_MS = 120

// An indexed frame as a PNG data URL: each cell is cell x cell pixels, the panel-order RGB565 palette swapped back
// (the swap is its own inverse), index 0 clear.
export function frameUrl(frame: IndexedFrame, palette: number[]): string {
  const { cols, rows, cell } = frame
  const png = new PNG({ width: cols * cell, height: rows * cell })
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const index = frame.cells[Math.floor(y / cell) * cols + Math.floor(x / cell)]
      if (!index) continue
      const [r, g, b] = expand565(panelOrder(palette[index] ?? 0))
      png.data.set([r, g, b, 255], (y * png.width + x) * 4)
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`
}

// What the Devices tab animates: every scene's (not relaxing: the app does not show it, and it would add a full-size
// scene to a reply that is capped) frames as data URLs, with the step each is shown for.
export function previewFrames(pet: ConvertedPet) {
  const url = (indices: number[]) => indices.map((i) => frameUrl(pet.frames[i], pet.palette))
  return {
    frames: {
      small: url([...new Set(pet.small.loops.idle)]),
      asking: url([...new Set(pet.small.loops.asking)]),
      working: url(pet.working.frames),
      listening: url(pet.listening.frames),
      sending: url(pet.sending.frames),
    },
    stepMs: { small: SMALL_STEP_MS, asking: SMALL_STEP_MS, working: pet.working.stepMs, listening: pet.listening.stepMs, sending: pet.sending.stepMs },
  }
}

// The row picker's pictures are small: a frame is at most this tall, so a whole 9 x 8 sheet stays a few hundred KB.
export const STRIP_FRAME_MAX_H = 64

// Every row with frames, in sheet order, as one PNG data URL of its frames side by side: the source art (not the
// pack's palette, which depends on the rows chosen), box-filtered down to at most 64 px tall, clear where it is clear.
export function sheetStrips(sheet: PetSheet): Array<{ row: PetRow; frames: number; strip: string }> {
  const h = Math.min(STRIP_FRAME_MAX_H, sheet.cellH)
  const w = Math.max(1, Math.round((sheet.cellW * h) / sheet.cellH))
  return PET_ROWS.filter((row) => sheet.rows[row].length > 0).map((row) => {
    const frames = sheet.rows[row]
    const png = new PNG({ width: w * frames.length, height: h })
    frames.forEach((f, n) => drawScaled(f, png, n * w, w, h))
    return { row, frames: frames.length, strip: `data:image/png;base64,${PNG.sync.write(png).toString('base64')}` }
  })
}

// Each output pixel averages the source pixels it covers, colours weighted by their alpha so clear pixels add no
// black fringe.
function drawScaled(f: RgbaFrame, out: PNG, x0: number, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * f.height) / h)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * f.height) / h))
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * f.width) / w)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * f.width) / w))
      let n = 0
      let a = 0
      let r = 0
      let g = 0
      let b = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * f.width + sx) * 4
          const alpha = f.data[i + 3]
          n++
          a += alpha
          r += f.data[i] * alpha
          g += f.data[i + 1] * alpha
          b += f.data[i + 2] * alpha
        }
      }
      if (a === 0) continue
      out.data.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)], (y * out.width + x0 + x) * 4)
    }
  }
}
