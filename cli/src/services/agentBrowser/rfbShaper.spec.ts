import { afterEach, describe, expect, it, vi } from 'vitest'
import { RfbShaper } from './rfbShaper.js'

const relay = { quality: 3, compression: 6, fps: 5 }
const direct = { quality: 6, compression: 2, fps: 15 }

const handshake = [...Buffer.from('RFB 003.008\n'), 1, 1]
const s32 = (n: number) => [(n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]
const setEncodings = (encs: number[]) => [2, 0, encs.length >> 8, encs.length & 255, ...encs.flatMap(s32)]
const update = (incremental: 0 | 1, width = 1920) => [3, incremental, 0, 0, 0, 0, width >> 8, width & 255, 4, 56]
const key = [4, 1, 0, 0, 0, 0, 0, 0x61]
const pointer = [5, 1, 0, 10, 0, 20]
const cutText = (text: string) => [6, 0, 0, 0, ...s32(Buffer.byteLength(text)), ...Buffer.from(text)]

function rig(profile = relay) {
  let t = 0
  const timers: { at: number; fn: () => void }[] = []
  const out: number[][] = []
  const closes: [string, string][] = []
  const shaper = new RfbShaper(profile, () => t, (ms, fn) => { timers.push({ at: t + ms, fn }) })
  shaper.onOutput((bytes) => { out.push([...bytes]) })
  shaper.onClose((reason, detail) => { closes.push([reason, detail]) })
  const push = (...messages: number[][]) => { shaper.push(Uint8Array.from(messages.flat())) }
  const advance = (ms: number) => {
    t += ms
    for (;;) {
      const due = timers.filter((timer) => timer.at <= t).sort((a, b) => a.at - b.at)[0]
      if (!due) return
      timers.splice(timers.indexOf(due), 1)
      due.fn()
    }
  }
  return { shaper, out, closes, push, advance }
}

function opened(profile = relay) {
  const r = rig(profile)
  r.push(handshake)
  r.out.length = 0
  return r
}

describe('RfbShaper', () => {
  afterEach(() => { vi.useRealTimers() })

  it('the handshake passes through unchanged', () => {
    const r = rig()
    r.push(handshake.slice(0, 5))
    r.push(handshake.slice(5))
    expect(r.out.flat()).toEqual(handshake)

    // A client that answers 3.3 sends no security type: its handshake is the version and ClientInit only.
    const old = rig()
    old.push([...Buffer.from('RFB 003.003\n'), 1], key)
    expect(old.out).toEqual([[...Buffer.from('RFB 003.003\n'), 1], key])
  })

  it('SetEncodings quality and compression are replaced; other encodings keep their order', () => {
    const r = opened()
    // Tight, TightPNG, CopyRect, quality 9, compression 0, fine quality 95, subsampling 1X, LastRect, Raw.
    r.push(setEncodings([7, -260, 1, -23, -256, -417, -768, -224, 0]))
    expect(r.out).toEqual([setEncodings([7, -260, 1, -224, 0, -32 + 3, -256 + 6])])

    // A client that names no level still gets the profile's.
    r.push(setEncodings([7]))
    expect(r.out[1]).toEqual(setEncodings([7, -29, -250]))
  })

  it('SetEncodings drops continuous updates and extended mouse buttons', () => {
    const r = opened()
    r.push(setEncodings([7, -313, -316, -312]))
    expect(r.out).toEqual([setEncodings([7, -312, -29, -250])])
  })

  it('update requests are held to the frame interval; a newer one replaces a held one', () => {
    const r = opened()
    r.push(update(1, 1))
    expect(r.out).toEqual([update(1, 1)])
    r.advance(50)
    r.push(update(1, 2))
    r.advance(50)
    r.push(update(1, 3))
    expect(r.out).toHaveLength(1)
    r.advance(99)
    expect(r.out).toHaveLength(1)
    r.advance(1)
    expect(r.out).toEqual([update(1, 1), update(1, 3)])
    r.advance(250)
    r.push(update(1, 4))
    expect(r.out[2]).toEqual(update(1, 4))
  })

  it('a held full update request stays full when a newer incremental one replaces it', () => {
    const r = opened()
    r.push(update(1))
    r.push(update(0, 1))
    r.push(update(1, 2))
    r.advance(200)
    expect(r.out).toEqual([update(1), update(0, 2)])
  })

  it('keys, pointer and clipboard pass at once and in order, between held requests', () => {
    const r = opened()
    r.push(update(1, 1), update(1, 2), key, pointer, cutText('chào'))
    expect(r.out).toEqual([update(1, 1), key, pointer, cutText('chào')])
    r.advance(200)
    expect(r.out[4]).toEqual(update(1, 2))
  })

  it('messages split across chunks, and several in one chunk, parse the same', () => {
    const pixelFormat = [0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]
    const fence = [248, 0, 0, 0, ...s32(0x80000001), 3, 1, 2, 3]
    const desktopSize = [251, 0, 7, 128, 4, 56, 1, 0, ...s32(0), 0, 0, 0, 0, 7, 128, 4, 56, ...s32(0)]
    const xvp = [250, 0, 1, 2]
    const qemuKey = [255, 0, 0, 1, ...s32(0x61), ...s32(30)]
    const stream = [
      pixelFormat, setEncodings([7, 1]), update(0), key, pointer, cutText('hi'), fence, desktopSize, xvp, qemuKey,
    ]
    const expected = [pixelFormat, setEncodings([7, 1, -29, -250]), update(0), key, pointer, cutText('hi'),
      fence, desktopSize, xvp, qemuKey]

    const whole = opened()
    whole.push(...stream)
    expect(whole.out).toEqual(expected)

    const split = opened()
    for (const byte of stream.flat()) split.push([byte])
    expect(split.out).toEqual(expected)
    expect(split.closes).toEqual([])
  })

  it('an extended-clipboard ClientCutText with a negative length is passed whole', () => {
    const r = opened()
    // Notify, text format: the 4-byte flags are the whole payload, so the length is -4.
    const notify = [6, 0, 0, 0, ...s32(-4), 0x08, 0, 0, 0x01]
    r.push(notify, key)
    expect(r.out).toEqual([notify, key])
  })

  it('an unknown message type closes with reason closed', () => {
    const r = opened()
    r.push(update(1), update(1, 2), [7, 0, 0, 0])
    expect(r.closes).toEqual([['closed', 'unknown RFB client message type 7']])
    r.push(key)
    r.advance(200)
    expect(r.out).toEqual([update(1)])

    const continuous = opened()
    continuous.push([150, 1, 0, 0, 0, 0, 7, 128, 4, 56])
    expect(continuous.closes).toEqual([['closed', 'unknown RFB client message type 150']])

    const qemu = opened()
    qemu.push([255, 1, 0, 0])
    expect(qemu.closes).toEqual([['closed', 'unknown RFB client message type 255.1']])
  })

  it('a message longer than the largest one Xvnc takes closes with reason closed', () => {
    const r = opened()
    r.push([6, 0, 0, 0, ...s32(256 * 1024 + 1)])
    expect(r.closes).toEqual([['closed', 'RFB client message type 6 is 262153 bytes']])
    const negative = opened()
    negative.push([6, 0, 0, 0, ...s32(-(256 * 1024 + 1))])
    expect(negative.closes).toHaveLength(1)
    const atLimit = opened()
    atLimit.push(cutText('x'.repeat(256 * 1024)))
    expect(atLimit.closes).toEqual([])
    expect(atLimit.out).toHaveLength(1)
  })

  it('setProfile applies to the next SetEncodings and the next interval', () => {
    const r = opened()
    r.shaper.setProfile(direct)
    expect(r.out).toEqual([])
    r.push(setEncodings([7, -23]))
    expect(r.out).toEqual([setEncodings([7, -32 + 6, -256 + 2])])
    r.push(update(1, 1), update(1, 2))
    r.advance(66)
    expect(r.out).toHaveLength(2)
    r.advance(1)
    expect(r.out[2]).toEqual(update(1, 2))
  })

  it('setProfile sends the last SetEncodings again with the new levels', () => {
    // The route is known only after the viewer has sent its SetEncodings, and noVNC sends it again only when its
    // own settings change: without this, a stream that turns out direct would keep the relay levels.
    const r = opened()
    r.push(setEncodings([7, 1, -23]))
    r.shaper.setProfile(direct)
    expect(r.out).toEqual([setEncodings([7, 1, -29, -250]), setEncodings([7, 1, -26, -254])])
  })

  it('uses the real clock and timers by default', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
    const out: number[][] = []
    const shaper = new RfbShaper(relay)
    shaper.onOutput((bytes) => { out.push([...bytes]) })
    shaper.push(Uint8Array.from([...handshake, ...update(1, 1), ...update(1, 2)]))
    expect(out).toHaveLength(2)
    vi.advanceTimersByTime(200)
    expect(out[2]).toEqual(update(1, 2))
  })

  it('needs no listeners', () => {
    const shaper = new RfbShaper(relay, () => 0, () => {})
    expect(() => { shaper.push(Uint8Array.from([...handshake, 7])) }).not.toThrow()
  })
})
