import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { PET_ROWS, parsePetSheet, type PetRow, type PetSheet, type RgbaFrame } from './sheet.js'
import { convertPet } from './convert.js'
import { STRIP_FRAME_MAX_H, previewFrames, sheetStrips } from './preview.js'

// A cell that is solid (r, g, b) in its left half and clear in its right half.
function cell(w: number, h: number, rgb: [number, number, number]): RgbaFrame {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) data.set([...rgb, 255], (y * w + x) * 4)
  return { width: w, height: h, data }
}

function sheet(cellW: number, cellH: number, counts: Partial<Record<PetRow, number>>): PetSheet {
  const rows = {} as Record<PetRow, RgbaFrame[]>
  for (const name of PET_ROWS) rows[name] = Array.from({ length: counts[name] ?? 0 }, (_, i) => cell(cellW, cellH, [200, 10 * i, 50]))
  return { cellW, cellH, rows }
}

const decode = (url: string) => PNG.sync.read(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'))

describe('sheetStrips', () => {
  it('one strip per non-empty row, in sheet order, frames side by side at most 64 px tall', () => {
    for (const [w, h] of [[192, 208], [96, 104]]) {
      const strips = sheetStrips(sheet(w, h, { review: 2, idle: 3, jumping: 1 }))
      expect(strips.map((s) => [s.row, s.frames])).toEqual([['idle', 3], ['jumping', 1], ['review', 2]])
      const png = decode(strips[0].strip)
      expect(STRIP_FRAME_MAX_H).toBe(64)
      expect([png.width, png.height]).toEqual([59 * 3, 64])
    }
  })

  it('keeps the colours and the clear background', () => {
    const png = decode(sheetStrips(sheet(192, 208, { idle: 1 }))[0].strip)
    expect([...png.data.subarray(0, 4)]).toEqual([200, 0, 50, 255])
    const right = (10 * png.width + png.width - 1) * 4
    expect(png.data[right + 3]).toBe(0)
  })

  it('a cell shorter than 64 px is not scaled up', () => {
    const strips = sheetStrips(sheet(16, 20, { running: 2 }))
    expect([decode(strips[0].strip).width, decode(strips[0].strip).height]).toEqual([32, 20])
  })
})

// pet_preview's reply goes from the devices process to the core and on to the app over the local socket, whose
// messages are capped at 6 MiB + 4 KiB (localWsServer.ts MAX_WS_MESSAGE_BYTES). Its pictures are bounded by a sheet
// of full-size cells drawn edge to edge in noise, every row full: more than any sheet that converts (a pack over 1 MB
// is refused) and than any file under 8 MB holds. The scenes' and the small pet's frames are as many as they can be
// with the default rows (three scenes of 8, the small pet's 8 idle and 8 waving, 8 asking).
describe('pet_preview size', () => {
  it('a full 9 x 8 sheet of noise fits the local socket limit', () => {
    const png = new PNG({ width: 1536, height: 1872 })
    let seed = 1
    for (let i = 0; i < png.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      png.data.set([seed & 0xff, (seed >> 8) & 0xff, (seed >> 16) & 0xff, 255], i)
    }
    const sheet = parsePetSheet(PNG.sync.write(png))
    expect(PET_ROWS.every((row) => sheet.rows[row].length === 8)).toBe(true)
    const strips = JSON.stringify(sheetStrips(sheet)).length
    const frames = JSON.stringify(previewFrames(convertPet(sheet))).length
    process.stderr.write(`pet_preview worst case: sheetRows ${strips} B, frames ${frames} B\n`)
    expect(strips).toBeLessThan(1.25 * 1024 * 1024)
    // The rest of the reply (id, name, rows, warnings, …) is a few hundred bytes.
    expect(strips + frames).toBeLessThan(6 * 1024 * 1024)
  }, 60_000)
})
