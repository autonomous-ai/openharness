import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ConvertedPet, IndexedFrame } from './convert.js'
import { PACK_MAX_BYTES, PACK_VERSION, decodePack, encodePack } from './pack.js'
import { PetSheetError } from './sheet.js'

const VECTOR = fileURLToPath(
  new URL('../../../../devices/harness-device/firmware/test/vectors/pet_min.hpet', import.meta.url),
)
const ID = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])

function frame(cell: number, rows: string[]): IndexedFrame {
  // '.' transparent, '1'..'9' palette index.
  const cols = rows[0].length
  const cells = new Uint8Array(cols * rows.length)
  rows.forEach((row, y) => [...row].forEach((ch, x) => (cells[y * cols + x] = ch === '.' ? 0 : Number(ch))))
  return { cols, rows: rows.length, cell, cells }
}

// Two 8 x 8 frames: runs at the start, middle and end of rows, a blank row and a full row.
function fixture(): ConvertedPet {
  const a = frame(2, ['..1221..', '.123321.', '12333321', '........', '1......1', '..1..1..', '.......1', '11111111'])
  const b = frame(1, ['3.......', '.3.....3', '..3...3.', '...3.3..', '....3...', '...3.3..', '..3...3.', '.3.....3'])
  const scene = (frames: number[], dx = 0, dy = 0) => ({ frames, stepMs: 120, dx, dy })
  return {
    palette: [0, 0x00f8, 0xe007, 0x1f00],
    frames: [a, b],
    small: { w: 8, h: 8, loops: { idle: [0, 1, 0], done: [0], asking: [1] } },
    working: scene([1, 0]),
    listening: scene([0]),
    sending: scene([1, 1, 0], -3, 5),
    failed: scene([0]),
    warnings: [],
  }
}

function rewriteCrc(buf: Buffer): Buffer {
  buf.writeUInt32LE(crc32(buf.subarray(22)), 18)
  return buf
}

describe('pack', () => {
  it('round-trip: decodePack(encodePack(p)) deep-equals p', () => {
    const p = fixture()
    const back = decodePack(encodePack(p, ID))
    expect(back).toEqual({ ...p, id: '0102030405060708' })
  })

  it('header layout', () => {
    const buf = encodePack(fixture(), ID)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('HPET')
    expect(buf[4]).toBe(PACK_VERSION)
    expect([...buf.subarray(6, 14)]).toEqual([...ID])
    expect(buf.readUInt32LE(14)).toBe(buf.length)
    expect(buf.readUInt32LE(18)).toBe(crc32(buf.subarray(22)))
  })

  it('bad CRC / bad magic / version 2 → throws', () => {
    const good = encodePack(fixture(), ID)
    const crc = Buffer.from(good)
    crc[crc.length - 1] ^= 0xff
    expect(() => decodePack(crc)).toThrow(/CRC/)
    const magic = Buffer.from(good)
    magic[0] = 0x58
    expect(() => decodePack(magic)).toThrow(/magic/)
    const v2 = Buffer.from(good)
    v2[4] = 2
    expect(() => decodePack(rewriteCrc(v2))).toThrow(/version/)
    expect(() => decodePack(good.subarray(0, good.length - 3))).toThrow(/length/)
    expect(() => decodePack(good.subarray(0, 10))).toThrow()
  })

  it('over 1 MB → TOO_BIG with the MB message', () => {
    const p = fixture()
    // Random cells defeat the run encoding: 192 x 208 x 30 frames is far more than 1 MB.
    const noisy = (): IndexedFrame => {
      const cells = new Uint8Array(192 * 208)
      for (let i = 0; i < cells.length; i++) cells[i] = i % 2 ? 1 : 0
      cells[0] = 1
      return { cols: 192, rows: 208, cell: 1, cells: cells.map((v, i) => (v ? 1 + ((i * 7) % 3) : 0)) }
    }
    p.frames = Array.from({ length: 24 }, (_, n) => {
      const f = noisy()
      f.cells[1] = 1 + (n % 200)
      return f
    })
    expect(PACK_MAX_BYTES).toBe(1_048_576)
    try {
      encodePack(p, ID)
      throw new Error('did not throw')
    } catch (e) {
      expect(e).toBeInstanceOf(PetSheetError)
      expect((e as PetSheetError).code).toBe('TOO_BIG')
      expect((e as PetSheetError).message).toMatch(/^This pet is \d+\.\d MB; the limit is 1 MB$/)
    }
  })

  it('vector: encodePack(fixture) equals test/vectors/pet_min.hpet', () => {
    const buf = encodePack(fixture(), ID)
    if (process.env.UPDATE_VECTORS === '1') {
      mkdirSync(dirname(VECTOR), { recursive: true })
      writeFileSync(VECTOR, buf)
    }
    expect(readFileSync(VECTOR).equals(buf)).toBe(true)
  })
})
