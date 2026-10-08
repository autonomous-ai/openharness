import { crc32 } from 'node:zlib'
import type { ConvertedPet, IndexedFrame, PetScene } from './convert.js'
import { PetSheetError } from './sheet.js'

// The HPET pack: a converted pet in the firmware's own cell-sprite format, little-endian throughout.
//
//   "HPET" · version u8 · flags u8 · id u8[8] · length u32 (whole pack) · crc32 u32 (of every byte after this field)
//   palette: count u8 (entries incl. index 0) · count x u16
//   small:   w u16 · h u16 · loops idle/done/asking: each n u8 · n x u16 frame index
//   scenes:  working, listening, sending, failed: each n u8 · step_ms u16 · dx i16 · dy i16 · n x u16 frame index
//   frames:  count u16 · per frame: cols u8 · rows u8 · cell u8 · row_at u16[rows] · packed rows
export const PACK_VERSION = 1
export const PACK_MAX_BYTES = 1_048_576

const MAGIC = 'HPET'
const HEADER_BYTES = 22 // magic, version, flags, id, length, crc
const CRC_AT = 18
const SCENES = ['working', 'listening', 'sending', 'failed'] as const
const LOOPS = ['idle', 'done', 'asking'] as const

class Writer {
  private parts: Buffer[] = []
  u8(v: number) {
    this.parts.push(Buffer.from([v]))
  }
  u16(v: number) {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(v)
    this.parts.push(b)
  }
  i16(v: number) {
    const b = Buffer.alloc(2)
    b.writeInt16LE(v)
    this.parts.push(b)
  }
  bytes(b: Uint8Array | number[]) {
    this.parts.push(Buffer.from(b))
  }
  done(): Buffer {
    return Buffer.concat(this.parts)
  }
}

// Per row, pairs of (transparent cells to skip, opaque cells that follow) each followed by those cells' indices,
// until `cols` are covered — scripts/gen_pets.py pack_rows, byte for byte (a row that ends transparent ends with a
// pair whose run is 0). `at[r]` is where row r starts in the packed bytes.
function packRows(f: IndexedFrame): { packed: number[]; at: number[] } {
  const packed: number[] = []
  const at: number[] = []
  for (let r = 0; r < f.rows; r++) {
    at.push(packed.length)
    let x = 0
    while (x < f.cols) {
      let skip = 0
      while (x < f.cols && !f.cells[r * f.cols + x]) {
        skip++
        x++
      }
      const run: number[] = []
      while (x < f.cols && f.cells[r * f.cols + x]) {
        run.push(f.cells[r * f.cols + x])
        x++
      }
      packed.push(skip, run.length, ...run)
    }
  }
  return { packed, at }
}

export function encodePack(pet: ConvertedPet, id: Uint8Array): Buffer {
  if (id.length !== 8) throw new Error('A pet id is 8 bytes')
  const body = new Writer()
  if (pet.palette.length > 255) throw new Error('A palette has at most 255 entries')
  body.u8(pet.palette.length)
  for (const c of pet.palette) body.u16(c)
  body.u16(pet.small.w)
  body.u16(pet.small.h)
  for (const name of LOOPS) {
    const loop = pet.small.loops[name]
    body.u8(loop.length)
    for (const n of loop) body.u16(n)
  }
  for (const name of SCENES) {
    const s = pet[name]
    body.u8(s.frames.length)
    body.u16(s.stepMs)
    body.i16(s.dx)
    body.i16(s.dy)
    for (const n of s.frames) body.u16(n)
  }
  body.u16(pet.frames.length)
  for (const f of pet.frames) {
    const { packed, at } = packRows(f)
    if (packed.length > 0xffff) throw new Error('A frame is too large to pack')
    body.u8(f.cols)
    body.u8(f.rows)
    body.u8(f.cell)
    for (const o of at) body.u16(o)
    body.bytes(packed)
  }
  const payload = body.done()
  const total = HEADER_BYTES + payload.length
  if (total > PACK_MAX_BYTES) {
    throw new PetSheetError('TOO_BIG', `This pet is ${(total / 1_048_576).toFixed(1)} MB; the limit is 1 MB`)
  }
  const head = Buffer.alloc(HEADER_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head[4] = PACK_VERSION
  head[5] = 0 // flags
  head.set(id, 6)
  head.writeUInt32LE(total, 14)
  head.writeUInt32LE(crc32(payload), CRC_AT)
  return Buffer.concat([head, payload])
}

class Reader {
  at: number
  constructor(
    private buf: Buffer,
    start: number,
  ) {
    this.at = start
  }
  private need(n: number) {
    if (this.at + n > this.buf.length) throw new Error('The pet pack is truncated')
  }
  u8(): number {
    this.need(1)
    return this.buf[this.at++]
  }
  u16(): number {
    this.need(2)
    const v = this.buf.readUInt16LE(this.at)
    this.at += 2
    return v
  }
  i16(): number {
    this.need(2)
    const v = this.buf.readInt16LE(this.at)
    this.at += 2
    return v
  }
}

export function decodePack(buf: Buffer): ConvertedPet & { id: string } {
  if (buf.length < HEADER_BYTES) throw new Error('The pet pack is truncated')
  if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('Not a pet pack: bad magic')
  if (buf[4] !== PACK_VERSION) throw new Error(`Unsupported pet pack version ${buf[4]}`)
  if (buf.readUInt32LE(14) !== buf.length) throw new Error('The pet pack has the wrong length')
  if (buf.readUInt32LE(CRC_AT) !== crc32(buf.subarray(HEADER_BYTES))) throw new Error('The pet pack failed its CRC check')
  const id = buf.subarray(6, 14).toString('hex')
  const r = new Reader(buf, HEADER_BYTES)

  const palette: number[] = []
  for (let n = r.u8(); n > 0; n--) palette.push(r.u16())
  const w = r.u16()
  const h = r.u16()
  const loops = {} as Record<(typeof LOOPS)[number], number[]>
  for (const name of LOOPS) {
    const loop: number[] = []
    for (let n = r.u8(); n > 0; n--) loop.push(r.u16())
    loops[name] = loop
  }
  const scenes = {} as Record<(typeof SCENES)[number], PetScene>
  for (const name of SCENES) {
    const n = r.u8()
    const stepMs = r.u16()
    const dx = r.i16()
    const dy = r.i16()
    const frames: number[] = []
    for (let i = 0; i < n; i++) frames.push(r.u16())
    scenes[name] = { frames, stepMs, dx, dy }
  }
  const frames: IndexedFrame[] = []
  for (let count = r.u16(); count > 0; count--) {
    const cols = r.u8()
    const rows = r.u8()
    const cell = r.u8()
    const at: number[] = []
    for (let i = 0; i < rows; i++) at.push(r.u16())
    const base = r.at
    const cells = new Uint8Array(cols * rows)
    for (let y = 0; y < rows; y++) {
      if (r.at - base !== at[y]) throw new Error('The pet pack has a bad row offset')
      let x = 0
      while (x < cols) {
        const skip = r.u8()
        const run = r.u8()
        if (x + skip + run > cols) throw new Error('The pet pack has a row longer than its frame')
        x += skip
        for (let i = 0; i < run; i++) cells[y * cols + x++] = r.u8()
      }
    }
    frames.push({ cols, rows, cell, cells })
  }
  if (r.at !== buf.length) throw new Error('The pet pack has trailing bytes')
  for (const s of [...Object.values(scenes), { frames: Object.values(loops).flat() }]) {
    if (s.frames.some((n) => n >= frames.length)) throw new Error('The pet pack points at a missing frame')
  }
  return { id, palette, frames, small: { w, h, loops }, ...scenes, warnings: [] }
}
