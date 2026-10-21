import { describe, expect, it } from 'vitest'
import { imageInfo } from './attachments.js'

const bytes = (...parts: Array<number[] | string>) => Uint8Array.from(parts.flatMap(p => typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p))
const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]

describe('Super Tab image attachments', () => {
  it('reads the type and size of PNG, JPEG and WebP from their own headers', () => {
    expect(imageInfo(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], be32(13), 'IHDR', be32(640), be32(480))))
      .toEqual({ mime: 'image/png', width: 640, height: 480 })
    // SOI, an APP0 segment to skip, then a baseline frame header: height 300, width 400.
    expect(imageInfo(bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0])))
      .toEqual({ mime: 'image/jpeg', width: 400, height: 300 })
    expect(imageInfo(bytes([0xff, 0xd8, 0xff, 0xdb]))).toEqual({ mime: 'image/jpeg', width: null, height: null })
    const riff = (chunk: string, body: number[]) => bytes('RIFF', [0, 0, 0, 0], 'WEBP', chunk, [0, 0, 0, 0], body)
    expect(imageInfo(riff('VP8X', [0, 0, 0, 0, 0x1f, 0x03, 0x00, 0xdf, 0x01, 0x00]))).toEqual({ mime: 'image/webp', width: 800, height: 480 })
    expect(imageInfo(riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0x20, 0x03, 0xe0, 0x01]))).toEqual({ mime: 'image/webp', width: 800, height: 480 })
    expect(imageInfo(riff('VP8L', [0x2f, 0x1f, 0xc3, 0x77, 0x00]))).toEqual({ mime: 'image/webp', width: 800, height: 480 })
  })

  it('refuses anything else, whatever it is called', () => {
    expect(imageInfo(bytes('GIF89a'))).toBeNull()
    expect(imageInfo(bytes('BM'))).toBeNull()
    expect(imageInfo(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imageInfo(new Uint8Array())).toBeNull()
  })
})
