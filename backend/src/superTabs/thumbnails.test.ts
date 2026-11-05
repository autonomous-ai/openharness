import { crc32 } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { createThumbnailer, imageFacts, makeThumbnail, MAX_THUMB_PIXELS, THUMB_LONG_SIDE, thumbKeyOf, type ImageFacts } from './thumbnails.js'

// Task #3177: the server makes a small copy of a picture when it is uploaded, so a chat draws that and not the whole file.

/** Noise, so the original is large and a thumbnail is clearly smaller. */
const noise = (width: number, height: number) => ({ raw: { width, height, channels: 3 as const }, data: randomBytes(width * height * 3) })
async function jpeg(width: number, height: number, orientation?: number) {
  const { raw, data } = noise(width, height)
  return sharp(data, { raw }).jpeg({ quality: 95 }).withMetadata(orientation ? { orientation } : {}).toBuffer()
}
/** Stripes of eight colours: a real many-colour picture whose palette a GIF encoder finds at once. GIF-encoding noise of
 *  the same size takes about 3 s on a fast Mac, which put this file's 5 s test timeout at the mercy of CI load (batch #3152). */
function stripes(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const colour = ((x >> 5) + (y >> 5)) % 8, at = (y * width + x) * 3
    data[at] = (colour & 1) * 255; data[at + 1] = ((colour >> 1) & 1) * 255; data[at + 2] = ((colour >> 2) & 1) * 255
  }
  return { raw: { width, height, channels: 3 as const }, data }
}
async function png(width: number, height: number) {
  const { raw, data } = noise(width, height)
  return sharp(data, { raw }).png().toBuffer()
}

/** A PNG whose header claims [width] x [height] and holds no pixels: enough to read its size, never to decode it. */
function pngClaiming(width: number, height: number): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}

describe('makeThumbnail', () => {
  it('makes a WebP of 720 px on the long side, with its size, for a large JPEG', async () => {
    const original = await jpeg(2000, 1500)
    const facts = await makeThumbnail(original)
    expect(facts).toMatchObject({ width: 2000, height: 1500, thumb: { width: THUMB_LONG_SIDE, height: 540 } })
    const meta = await sharp(facts!.thumb!.bytes).metadata()
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({ format: 'webp', width: 720, height: 540 })
    expect(facts!.thumb!.bytes.byteLength).toBeLessThan(original.byteLength * 0.8)
  })

  it('also thumbnails a large PNG, and a tall picture on its height', async () => {
    const wide = await makeThumbnail(await png(1600, 900))
    expect(wide?.thumb).toMatchObject({ width: 720, height: 405 })
    const tall = await makeThumbnail(await jpeg(900, 1800))
    expect(tall?.thumb).toMatchObject({ width: 360, height: 720 })
  })

  it('shows a picture as it is held: the facts and the thumbnail follow its EXIF rotation, and carry none', async () => {
    const facts = await makeThumbnail(await jpeg(1600, 800, 6))
    expect(facts).toMatchObject({ width: 800, height: 1600, thumb: { width: 360, height: 720 } })
    const meta = await sharp(facts!.thumb!.bytes).metadata()
    expect(meta.exif).toBeUndefined()
    expect(meta.orientation ?? 1).toBe(1)
  })

  it('keeps width and height but no thumbnail when a smaller copy is not worth it', async () => {
    const small = await sharp(noise(400, 300).data, { raw: noise(400, 300).raw }).webp({ quality: 80 }).toBuffer()
    const facts = await makeThumbnail(small)
    expect(facts).toEqual({ width: 400, height: 300 })
  })

  it('never enlarges', async () => {
    const facts = await makeThumbnail(await png(300, 200))
    expect(facts?.thumb ? facts.thumb.width <= 300 && facts.thumb.height <= 200 : true).toBe(true)
  })

  it('leaves an animated WebP alone, as a GIF, so it keeps moving in the chat', async () => {
    const frames = 3, width = 300, height = 200
    const animated = await sharp(randomBytes(width * height * 3 * frames), { raw: { width, height: height * frames, channels: 3, pageHeight: height } })
      .webp({ loop: 0, delay: [100, 100, 100] }).toBuffer()
    expect((await sharp(animated).metadata()).pages).toBe(3)
    expect(await makeThumbnail(animated)).toBeNull()
  })

  it('answers nothing for what is not a picture it handles', async () => {
    // A real GIF, past the thumbnail's long side, that a GIF encoder writes in milliseconds.
    const pattern = stripes(900, 900)
    const gif = await sharp(pattern.data, { raw: pattern.raw }).gif().toBuffer()
    expect(await sharp(gif).metadata()).toMatchObject({ format: 'gif', width: 900, height: 900 })
    expect(await makeThumbnail(gif)).toBeNull()
    expect(await makeThumbnail(Buffer.from('not a picture at all'))).toBeNull()
    expect(await makeThumbnail(Buffer.alloc(0))).toBeNull()
    expect(await makeThumbnail((await jpeg(800, 600)).subarray(0, 300))).toBeNull()
    expect(await makeThumbnail(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900"></svg>'))).toBeNull()
  })

  it('gives up on a picture past 64 megapixels without decoding it', async () => {
    expect(await makeThumbnail(pngClaiming(20_000, 20_000))).toBeNull()
  })

  it('never throws', async () => {
    await expect(makeThumbnail(randomBytes(5000))).resolves.toBeNull()
    await expect(makeThumbnail(pngClaiming(100, 100))).resolves.toBeNull()
  })
})

describe('what a picture may cost', () => {
  it('stops at 40 megapixels, which covers screenshots and cameras', async () => {
    expect(MAX_THUMB_PIXELS).toBe(40_000_000)
    expect(await makeThumbnail(pngClaiming(6_400, 6_400))).toBeNull()
  })

  it('answers nothing for a PNG with a good header and bad pixels, and for noise inside a JPEG', async () => {
    const png = pngClaiming(200, 200)
    const idat = Buffer.alloc(12 + 40); idat.writeUInt32BE(40, 0); idat.write('IDAT', 4, 'ascii'); randomBytes(40).copy(idat, 8)
    const corrupt = Buffer.concat([png.subarray(0, png.length - 12), idat, png.subarray(png.length - 12)])
    expect(await makeThumbnail(corrupt)).toBeNull()
    const jpg = await jpeg(800, 600)
    randomBytes(2000).copy(jpg, 1000)
    await expect(makeThumbnail(jpg)).resolves.toSatisfy(facts => facts === null || typeof facts.width === 'number')
  })
})

describe('the thumbnailer\'s limits', () => {
  const facts: ImageFacts = { width: 10, height: 10 }
  /** A decode the test finishes by hand, and how many started. */
  function slowDecode() {
    const pending: Array<() => void> = []
    const state = { started: 0, release: () => { pending.splice(0).forEach(done => done()) } }
    const decode = () => { state.started++; return new Promise<ImageFacts | null>(resolve => pending.push(() => resolve(facts))) }
    return { state, decode }
  }
  const bytes = Buffer.from('x')
  const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it('keeps a slot until its decode ends, even when the caller gave up waiting', async () => {
    const { state, decode } = slowDecode()
    const thumbnailer = createThumbnailer({ atOnce: 1, giveUpMs: 30, maxWaiting: 10, decode })
    expect(await thumbnailer.make(bytes)).toBeNull()
    expect(state.started).toBe(1)
    // The first decode still runs: nothing else starts beside it, and a caller that gave up before its turn is never decoded.
    expect(await thumbnailer.make(bytes)).toBeNull()
    expect(state.started).toBe(1)
    state.release()
    await later(10)
    expect(state.started).toBe(1)
    const third = thumbnailer.make(bytes)
    await later(5)
    expect(state.started).toBe(2)
    state.release()
    expect(await third).toEqual(facts)
  })

  it('does at most atOnce decodes together', async () => {
    const { state, decode } = slowDecode()
    const thumbnailer = createThumbnailer({ atOnce: 2, giveUpMs: 1_000, maxWaiting: 10, decode })
    const all = [1, 2, 3, 4].map(() => thumbnailer.make(bytes))
    await later(10)
    expect(state.started).toBe(2)
    state.release()
    await later(10)
    expect(state.started).toBe(4)
    state.release()
    expect(await Promise.all(all)).toEqual([facts, facts, facts, facts])
  })

  it('answers at once with nothing when its queue is full, and says it is busy', async () => {
    const { state, decode } = slowDecode()
    const thumbnailer = createThumbnailer({ atOnce: 1, giveUpMs: 1_000, maxWaiting: 1, decode })
    const running = thumbnailer.make(bytes)
    const waiting = thumbnailer.make(bytes)
    await later(5)
    expect(thumbnailer.busy()).toBe(true)
    const started = Date.now()
    expect(await thumbnailer.make(bytes)).toBeNull()
    expect(Date.now() - started).toBeLessThan(200)
    expect(state.started).toBe(1)
    state.release(); await later(5); state.release()
    expect(await Promise.all([running, waiting])).toEqual([facts, facts])
    expect(thumbnailer.busy()).toBe(false)
  })

  it('lets only as many pictures be held as it could work on, and takes a place back when it is given up', async () => {
    const thumbnailer = createThumbnailer({ atOnce: 1, maxWaiting: 1, giveUpMs: 1_000, decode: async () => facts })
    const first = thumbnailer.reserve(), second = thumbnailer.reserve()
    expect(first).toBeTypeOf('function')
    expect(second).toBeTypeOf('function')
    expect(thumbnailer.busy()).toBe(true)
    expect(thumbnailer.reserve()).toBeNull()
    first!()
    first!()
    expect(thumbnailer.busy()).toBe(false)
    const third = thumbnailer.reserve()
    expect(third).toBeTypeOf('function')
    expect(thumbnailer.reserve()).toBeNull()
    second!(); third!()
    expect(thumbnailer.reserve()).toBeTypeOf('function')
  })

  it('still makes the thumbnail of a picture that holds its place', async () => {
    const thumbnailer = createThumbnailer({ atOnce: 1, maxWaiting: 1, giveUpMs: 1_000, decode: async () => facts })
    const held = [thumbnailer.reserve(), thumbnailer.reserve()]
    expect(thumbnailer.busy()).toBe(true)
    expect(await thumbnailer.make(bytes)).toEqual(facts)
    held.forEach(release => release?.())
  })

  it('a decode that throws is nothing, and frees its place', async () => {
    let calls = 0
    const thumbnailer = createThumbnailer({ atOnce: 1, giveUpMs: 1_000, maxWaiting: 1, decode: async () => { if (calls++ === 0) throw new Error('boom'); return facts } })
    expect(await thumbnailer.make(bytes)).toBeNull()
    expect(await thumbnailer.make(bytes)).toEqual(facts)
  })
})

describe('thumbKeyOf', () => {
  it('sits beside the original, in its folder', () => {
    expect(thumbKeyOf('super-tabs/tab1/abcd/shot.png')).toBe('super-tabs/tab1/abcd/shot.png.thumb.webp')
  })
})

describe('imageFacts', () => {
  const good = { width: 2000, height: 1500, thumb: { url: 'https://cdn.example.test/super-tabs/t/k/a.png.thumb.webp', width: 720, height: 540, size: 41_000 } }

  it('keeps what a stored row holds', () => {
    expect(imageFacts(good)).toEqual(good)
    expect(imageFacts({ width: 400, height: 300 })).toEqual({ width: 400, height: 300 })
  })

  it('drops anything that is not a size, a thumbnail address or a count', () => {
    expect(imageFacts(null)).toBeNull()
    expect(imageFacts('x')).toBeNull()
    expect(imageFacts({ width: 0, height: 10 })).toBeNull()
    expect(imageFacts({ width: 1.5, height: 10 })).toBeNull()
    expect(imageFacts({ width: 10, height: 10, thumb: { url: 5, width: 1, height: 1, size: 1 } })).toEqual({ width: 10, height: 10 })
    expect(imageFacts({ width: 10, height: 10, thumb: { ...good.thumb, size: -1 } })).toEqual({ width: 10, height: 10 })
    expect(imageFacts({ ...good, extra: 'x', thumb: { ...good.thumb, extra: 'y' } })).toEqual(good)
  })
})
