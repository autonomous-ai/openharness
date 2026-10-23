import { expect, it } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as zlib from 'node:zlib'
import { completeZstdFrames } from './zstdFrames.js'

const zstd = zlib as typeof zlib & { zstdCompressSync: (value: string, options?: { params: Record<number, number> }) => Buffer }
async function check(bytes: Buffer, chunkSize = bytes.length || 1): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) chunks.push(bytes.subarray(i, i + chunkSize))
  const output: Buffer[] = []
  await pipeline(Readable.from(chunks), completeZstdFrames(), new Writable({ write(chunk, _encoding, done) { output.push(chunk); done() } }))
  return Buffer.concat(output)
}
const text = Array.from({ length: 50_000 }, (_, i) => `line ${i}\n`).join('')
it.each([1, 2, 3, 7, 64 * 1024])('accepts complete native multiblock frames in %i-byte chunks', async size => {
  const compressed = zstd.zstdCompressSync(text)
  expect(await check(compressed, size)).toEqual(compressed)
})
it('rejects every truncated prefix of a valid frame', async () => {
  const compressed = zstd.zstdCompressSync('a complete conversation')
  for (let end = 0; end < compressed.length; end++) await expect(check(compressed.subarray(0, end))).rejects.toThrow()
})
it('accepts concatenated frames, checksums, empty frames and skippable metadata', async () => {
  const skipped = Buffer.alloc(11)
  skipped.writeUInt32LE(0x184d2a50); skipped.writeUInt32LE(3, 4)
  const compressed = Buffer.concat([skipped, zstd.zstdCompressSync(''), zstd.zstdCompressSync(text, { params: { 201: 1 } })])
  expect(await check(compressed, 1)).toEqual(compressed)
  await expect(check(compressed.subarray(0, -1))).rejects.toThrow('Incomplete')
})
it('accepts a streaming frame without a content-size header and an RLE block', async () => {
  // Standard frame, window descriptor 0, last RLE block with 3 decoded bytes, payload "a".
  const bytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 27, 0, 0, 97])
  expect(await check(bytes, 1)).toEqual(bytes)
})
it.each([
  Buffer.from('not zstd'),
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 8]),
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 7, 0, 0]),
  Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0, 9, 0, 16]),
])('rejects invalid framing %#', async bytes => { await expect(check(bytes, 1)).rejects.toThrow() })
