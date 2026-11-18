import { inflateRawSync } from 'node:zlib'
import { expect } from 'vitest'
import { crc32 } from '../lib/zipWriter.js'

/** Enough of a ZIP reader to check what writeZip produced: walks the local headers. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const method = zip.readUInt16LE(at + 8)
    const crc = zip.readUInt32LE(at + 14)
    const csize = zip.readUInt32LE(at + 18)
    const nlen = zip.readUInt16LE(at + 26)
    const name = zip.subarray(at + 30, at + 30 + nlen).toString('utf8')
    const body = zip.subarray(at + 30 + nlen, at + 30 + nlen + csize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)
    expect(crc32(data)).toBe(crc)
    out.set(name, data)
    at += 30 + nlen + csize
  }
  expect(zip.readUInt32LE(at)).toBe(0x02014b50) // the central directory follows the last entry
  return out
}
