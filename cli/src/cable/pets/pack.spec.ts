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
    relaxing: scene([0, 1, 1], 2, -4),
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

  it('version 2 round-trips the relaxing scene right after failed', () => {
    const p = fixture()
    const buf = encodePack(p, ID, 2)
    expect(buf[4]).toBe(2)
    expect(decodePack(buf)).toEqual({ ...p, id: '0102030405060708' })
    // the scene is n u8 · step_ms u16 · dx i16 · dy i16 · n x u16, 3 + 4 + 6 bytes, after failed's
    const v1 = encodePack(p, ID, 1)
    const tail = Buffer.from([3, 120, 0, 2, 0, 0xfc, 0xff, 0, 0, 1, 0, 1, 0])
    expect(buf.includes(tail)).toBe(true)
    expect(buf.length).toBe(v1.length + tail.length)
  })

  it('version 1 has no relaxing scene and equals the pack before relaxing existed', () => {
    const p = fixture()
    const v1 = encodePack(p, ID, 1)
    expect(v1[4]).toBe(1)
    expect(decodePack(v1)).toEqual({ ...p, id: '0102030405060708', relaxing: { frames: [], stepMs: 0, dx: 0, dy: 0 } })
    expect(v1.equals(readFileSync(VECTOR))).toBe(true)
  })

  it('version 1 leaves out the frames only relaxing uses, keeping every other index', () => {
    const p = fixture()
    p.frames = [...p.frames, frame(1, ['1.1', '.1.'])]
    p.relaxing = { frames: [2, 0], stepMs: 120, dx: 0, dy: 0 }
    const v1 = decodePack(encodePack(p, ID, 1))
    expect(v1.frames).toEqual(p.frames.slice(0, 2))
    expect(decodePack(encodePack(p, ID, 2)).frames).toEqual(p.frames)
  })

  it('refuses a version it does not write', () => {
    expect(() => encodePack(fixture(), ID, 3)).toThrow(/version/)
  })

  it('header layout', () => {
    const buf = encodePack(fixture(), ID)
    expect(buf.subarray(0, 4).toString('latin1')).toBe('HPET')
    expect(buf[4]).toBe(PACK_VERSION)
    expect(PACK_VERSION).toBe(2)
    expect([...buf.subarray(6, 14)]).toEqual([...ID])
    expect(buf.readUInt32LE(14)).toBe(buf.length)
    expect(buf.readUInt32LE(18)).toBe(crc32(buf.subarray(22)))
  })

  it('bad CRC / bad magic / version 3 → throws', () => {
    const good = encodePack(fixture(), ID)
    const crc = Buffer.from(good)
    crc[crc.length - 1] ^= 0xff
    expect(() => decodePack(crc)).toThrow(/CRC/)
    const magic = Buffer.from(good)
    magic[0] = 0x58
    expect(() => decodePack(magic)).toThrow(/magic/)
    const v3 = Buffer.from(good)
    v3[4] = 3
    expect(() => decodePack(rewriteCrc(v3))).toThrow(/version/)
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
    p.working = { ...p.working, frames: p.frames.map((_, n) => n) } // in use by a scene other than relaxing: no scene to drop
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

  it('version 2 over 1 MB that fits as version 1 is written with an empty relaxing scene', () => {
    const noisy = (n: number): IndexedFrame => {
      const cells = new Uint8Array(192 * 208)
      for (let i = 0; i < cells.length; i++) cells[i] = 1 + ((i * 7 + n) % 3)
      cells[1] = 1 + (n % 200)
      return { cols: 192, rows: 208, cell: 1, cells }
    }
    // `m` noisy frames play the scenes the first 3 frames of relaxing come after.
    const make = (m: number): ConvertedPet => {
      const p = fixture()
      p.frames = Array.from({ length: m + 3 }, (_, n) => noisy(n))
      p.small.loops = { idle: [0], done: [0], asking: [0] }
      p.working = { ...p.working, frames: Array.from({ length: m }, (_, n) => n) }
      p.listening = { ...p.listening, frames: [0] }
      p.sending = { ...p.sending, frames: [0] }
      p.failed = { ...p.failed, frames: [0] }
      p.relaxing = { ...p.relaxing, frames: [m, m + 1, m + 2] }
      return p
    }
    let m = 1
    while (encodePack(make(m), ID, 1).length <= PACK_MAX_BYTES) {
      try {
        const full = encodePack(make(m), ID, 2)
        if (decodePack(full).relaxing.frames.length === 0) break
      } catch { break }
      m++
    }
    const p = make(m)
    const v1 = encodePack(p, ID, 1)
    expect(v1.length).toBeLessThanOrEqual(PACK_MAX_BYTES)
    const v2 = encodePack(p, ID, 2)
    expect(v2[4]).toBe(2)
    expect(v2.length).toBeLessThanOrEqual(PACK_MAX_BYTES)
    expect(decodePack(v2).relaxing.frames).toEqual([])
    expect(decodePack(v2).working.frames).toEqual(p.working.frames)
    // A pet that fits whole keeps its relaxing scene.
    expect(decodePack(encodePack(make(1), ID, 2)).relaxing.frames).toEqual([1, 2, 3])
  })

  it('vector: encodePack(fixture, version 1) equals test/vectors/pet_min.hpet', () => {
    const buf = encodePack(fixture(), ID, 1)
    if (process.env.UPDATE_VECTORS === '1') {
      mkdirSync(dirname(VECTOR), { recursive: true })
      writeFileSync(VECTOR, buf)
    }
    expect(readFileSync(VECTOR).equals(buf)).toBe(true)
  })
})
