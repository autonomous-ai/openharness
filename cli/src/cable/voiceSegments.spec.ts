import { afterEach, describe, expect, it, vi } from 'vitest'

import { VoiceLevel } from './voiceLevel.js'
import { realTimer, type SegmentTimer, type SegmentTranscriber, VoiceSegments } from './voiceSegments.js'

/** Bytes in one second of 16 kHz mono 16-bit audio. */
const SECOND = 32_000
/** Samples in one 20 ms frame at 16 kHz. */
const FRAME = 320
const UNAVAILABLE = 'Voice service unavailable'
const flush = () => new Promise(resolve => setImmediate(resolve))

/** `seconds` of audio at `rate` whose every sample is `amplitude`. */
function tone(seconds: number, rate: number, amplitude: number): Buffer {
  const sample = Buffer.alloc(2)
  sample.writeInt16LE(amplitude)
  return Buffer.alloc(Math.round(seconds * rate) * 2, sample)
}

/** Overwrites the frame of `frameSamples` samples that starts at sample `sample` with `amplitude`. */
function frameAt(pcm: Buffer, sample: number, frameSamples: number, amplitude: number): Buffer {
  for (let i = sample; i < sample + frameSamples; i++) pcm.writeInt16LE(amplitude, i * 2)
  return pcm
}

/** Audio that changes all the time, so its quietest frame is wherever the numbers put it; an odd length ends in half a sample. */
function varied(bytes: number): Buffer {
  const pcm = Buffer.alloc(bytes)
  for (let i = 0; i + 1 < bytes; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i / 997) * Math.sin(i / 61_003) * 30_000), i)
  if (bytes % 2) pcm[bytes - 1] = 0x7f
  return pcm
}

/** Pushes `pcm` in chunks of `sizes`, taken in turn. */
function pushIn(segments: VoiceSegments, pcm: Buffer, ...sizes: number[]): void {
  let at = 0
  for (let i = 0; at < pcm.length; i++) {
    const size = sizes[i % sizes.length]!
    segments.push(pcm.subarray(at, at + size))
    at += size
  }
}

/** Pushes `pcm` in chunks of `size` and lets every settled upload run on before the next, as a dial streams it. */
async function streamIn(segments: VoiceSegments, pcm: Buffer, size: number): Promise<void> {
  for (let at = 0; at < pcm.length; at += size) {
    segments.push(pcm.subarray(at, at + size))
    await flush()
  }
}

interface Call { pcm: Buffer; signal: AbortSignal; resolve(text: string): void; reject(error: unknown): void }
interface Timeout { fire(): void; ms: number }

/** A recording at 16 kHz in English unless told otherwise; its transcriber answers when the test settles `calls[i]`. */
function setup(options: { rate?: number; lang?: string; transcribe?: SegmentTranscriber } = {}) {
  const calls: Call[] = []
  const transcribe = vi.fn<SegmentTranscriber>(options.transcribe ?? ((pcm, signal) =>
    new Promise<string>((resolve, reject) => { calls.push({ pcm, signal, resolve, reject }) })))
  const timeouts = new Set<Timeout>()
  const timer: SegmentTimer = {
    set: (fire, ms) => {
      const timeout = { fire, ms }
      timeouts.add(timeout)
      return timeout
    },
    clear: handle => { timeouts.delete(handle as Timeout) },
  }
  const fire = () => {
    for (const timeout of [...timeouts]) {
      timeouts.delete(timeout)
      timeout.fire()
    }
  }
  const segments = new VoiceSegments({ rate: options.rate ?? 16_000, lang: options.lang ?? 'en', transcribe, timer })
  const sent = () => transcribe.mock.calls.map(([pcm]) => pcm.length)
  return { segments, transcribe, calls, sent, timeouts, fire }
}

const answering = (...texts: string[]): SegmentTranscriber => async () => texts.shift() ?? ''

describe('VoiceSegments', () => {
  it('cuts at the quietest 20 ms frame in [55 s, 60 s)', async () => {
    const { segments, calls, sent } = setup()
    const pcm = tone(60, 16_000, 1000)
    frameAt(pcm, 2_800 * FRAME, FRAME, 10)
    // Silent, but it ends at 55 s: outside the window, however quiet.
    frameAt(pcm, 2_749 * FRAME, FRAME, 0)
    // Its samples add up to less than any other frame's: the cut weighs their squares.
    frameAt(pcm, 2_950 * FRAME, FRAME, -30_000)
    segments.push(pcm)
    expect(sent()).toEqual([1_792_000])
    const done = segments.finish()
    calls[0]!.resolve('one')
    await flush()
    expect(sent()).toEqual([1_792_000, 128_000])
    calls[1]!.resolve('two')
    await expect(done).resolves.toBe('one two')
  })

  it('takes the latest of equally quiet frames', () => {
    const tied = setup()
    const pcm = tone(60, 16_000, 1000)
    frameAt(pcm, 2_800 * FRAME, FRAME, 0)
    frameAt(pcm, 2_900 * FRAME, FRAME, 0)
    tied.segments.push(pcm)
    expect(tied.sent()).toEqual([1_856_000])

    const constant = setup()
    constant.segments.push(tone(60, 16_000, 1000))
    expect(constant.sent()).toEqual([1_919_360])
  })

  it('cuts the same whatever the chunk sizes, never inside a sample', async () => {
    const pcm = varied(130 * SECOND + 1)
    const whole = setup({ transcribe: answering() })
    whole.segments.push(pcm)
    await whole.segments.finish()
    const split = setup({ transcribe: answering() })
    pushIn(split.segments, pcm, 7_999, 1)
    await split.segments.finish()

    const handed = whole.transcribe.mock.calls.map(([segment]) => segment)
    const handedSplit = split.transcribe.mock.calls.map(([segment]) => segment)
    expect(handed).toHaveLength(3)
    expect(handedSplit).toHaveLength(3)
    handed.forEach((segment, i) => expect(segment.equals(handedSplit[i]!)).toBe(true))
    expect(handedSplit.slice(0, -1).map(segment => segment.length % 2)).toEqual([0, 0])
    expect(Buffer.concat(handedSplit).equals(pcm)).toBe(true)
  })

  it('holds the rate to 8,000…48,000 and floors it', () => {
    const slow = setup({ rate: 1 })
    slow.segments.push(tone(70, 8_000, 1000))
    expect(slow.sent()).toEqual([959_680])

    for (const rate of [96_000, 48_000.7]) {
      const fast = setup({ rate })
      fast.segments.push(tone(61, 48_000, 1000))
      expect(fast.sent()).toEqual([5_758_080])
    }

    // A minute at 16 kHz is a whole segment only once the stated 16,000.5 is floored.
    const fractional = setup({ rate: 16_000.5 })
    fractional.segments.push(tone(60, 16_000, 1000))
    expect(fractional.sent()).toEqual([1_919_360])
  })

  it('makes at most 12 segments under the byte cap', async () => {
    const { segments, sent } = setup({ transcribe: answering() })
    const pcm = tone(615, 16_000, 1000)
    for (let n = 1; n * 880_000 < 615 * 16_000; n++) frameAt(pcm, n * 880_000, FRAME, 0)
    pushIn(segments, pcm, 8_000)
    await segments.finish()
    expect(sent()).toHaveLength(12)
    expect(sent().slice(0, 11)).toEqual(Array(11).fill(1_760_000))
    expect(sent().reduce((sum, bytes) => sum + bytes, 0)).toBe(19_680_000)
  })

  it('keeps one upload in flight and the order', async () => {
    const { segments, calls, sent } = setup()
    segments.push(tone(130, 16_000, 1000))
    await flush()
    expect(sent()).toEqual([1_919_360])
    calls[0]!.resolve('one')
    await flush()
    expect(sent()).toEqual([1_919_360, 1_919_360])
    const done = segments.finish()
    await flush()
    expect(sent()).toHaveLength(2)
    calls[1]!.resolve('two')
    await flush()
    expect(sent()).toEqual([1_919_360, 1_919_360, 321_280])
    calls[2]!.resolve('three')
    await expect(done).resolves.toBe('one two three')
    expect(segments.counts()).toEqual({ segments: 3, early: 2, retries: 0 })
  })

  it('drops empty transcripts and joins with a space, or nothing for ja', async () => {
    const spaced = setup({ transcribe: answering(' one ', '', 'two') })
    spaced.segments.push(tone(130, 16_000, 1000))
    await expect(spaced.segments.finish()).resolves.toBe('one two')

    const ja = setup({ lang: 'ja', transcribe: answering('こんにちは', '世界') })
    ja.segments.push(tone(70, 16_000, 1000))
    await expect(ja.segments.finish()).resolves.toBe('こんにちは世界')

    const silent = setup({ transcribe: answering('', '', '') })
    silent.segments.push(tone(130, 16_000, 0))
    await expect(silent.segments.finish()).resolves.toBe('')
    expect(silent.sent()).toHaveLength(3)
  })

  it('a recording under 60 s is one request at finish()', async () => {
    const { segments, calls, sent } = setup()
    segments.push(tone(59, 16_000, 1000))
    expect(sent()).toEqual([])
    const done = segments.finish()
    expect(sent()).toEqual([1_888_000])
    calls[0]!.resolve('hello')
    await expect(done).resolves.toBe('hello')
    expect(segments.counts()).toEqual({ segments: 1, early: 0, retries: 0 })

    const empty = setup()
    await expect(empty.segments.finish()).resolves.toBe('')
    expect(empty.sent()).toEqual([])
  })

  it('a failure before finish() is retried once, at once; a second stops the recording', async () => {
    const unavailable = new Error(UNAVAILABLE)
    const transcribe = vi.fn<SegmentTranscriber>()
      .mockRejectedValueOnce(unavailable).mockResolvedValueOnce('one')
      .mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable)
    const { segments, sent } = setup({ transcribe })
    await streamIn(segments, tone(130, 16_000, 1000), 8_000)
    expect(sent()).toEqual([1_919_360, 1_919_360, 1_919_360, 1_919_360])
    await streamIn(segments, tone(70, 16_000, 1000), 8_000)
    expect(sent()).toHaveLength(4)
    await expect(segments.finish()).rejects.toThrow(UNAVAILABLE)
    expect(sent()).toHaveLength(4)
    expect(segments.counts()).toEqual({ segments: 2, early: 2, retries: 2 })
  })

  it('a retry queued before finish() still runs, and the tail waits behind it', async () => {
    const { segments, calls, sent } = setup()
    segments.push(tone(70, 16_000, 1000))
    calls[0]!.reject(new Error(UNAVAILABLE))
    await flush()
    expect(sent()).toEqual([1_919_360, 1_919_360])
    const done = segments.finish()
    await flush()
    expect(sent()).toHaveLength(2)
    calls[1]!.resolve('one')
    await flush()
    expect(sent()).toEqual([1_919_360, 1_919_360, 320_640])
    calls[2]!.resolve('two')
    await expect(done).resolves.toBe('one two')
    expect(segments.counts()).toEqual({ segments: 2, early: 1, retries: 1 })
  })

  it.each([59, 61])('a failure after finish() is not retried (%i s)', async seconds => {
    const { segments, calls, sent } = setup()
    segments.push(tone(seconds, 16_000, 1000))
    const done = segments.finish()
    calls[0]!.reject(new Error(UNAVAILABLE))
    await expect(done).rejects.toThrow(UNAVAILABLE)
    await flush()
    expect(sent()).toHaveLength(1)
  })

  it('a timed-out attempt fails with its message, and its late answer is ignored', async () => {
    const { segments, calls, sent, timeouts, fire } = setup()
    segments.push(tone(59, 16_000, 1000))
    const done = segments.finish()
    expect([...timeouts].map(timeout => timeout.ms)).toEqual([120_000])
    fire()
    expect(calls[0]!.signal.aborted).toBe(true)
    await expect(done).rejects.toThrow('Voice upload timed out. Try again')
    calls[0]!.resolve('too late')
    await flush()
    expect(sent()).toHaveLength(1)
    expect(segments.counts()).toEqual({ segments: 1, early: 0, retries: 0 })
  })

  it('a first attempt that times out before finish() is retried, and a settled attempt leaves no timer', async () => {
    const { segments, calls, sent, timeouts, fire } = setup()
    segments.push(tone(61, 16_000, 1000))
    fire()
    await flush()
    expect(sent()).toEqual([1_919_360, 1_919_360])
    expect(timeouts.size).toBe(1)
    calls[1]!.resolve('one')
    await flush()
    expect(timeouts.size).toBe(0)
  })

  it('abort() aborts the attempt in flight and sends nothing more', async () => {
    const { segments, calls, sent, timeouts } = setup()
    segments.push(tone(61, 16_000, 1000))
    segments.abort()
    expect(calls[0]!.signal.aborted).toBe(true)
    segments.push(tone(70, 16_000, 1000))
    expect(sent()).toHaveLength(1)
    await expect(segments.finish()).rejects.toMatchObject({ name: 'AbortError' })
    calls[0]!.resolve('too late')
    await flush()
    expect(sent()).toHaveLength(1)
    expect(timeouts.size).toBe(0)
  })

  it('abort() rejects a finish() already waiting', async () => {
    const { segments, calls, sent } = setup()
    segments.push(tone(61, 16_000, 1000))
    const done = segments.finish()
    segments.abort()
    expect(calls[0]!.signal.aborted).toBe(true)
    await expect(done).rejects.toMatchObject({ name: 'AbortError' })
    calls[0]!.resolve('too late')
    await flush()
    expect(sent()).toHaveLength(1)
  })

  it('abort() after finish() resolved changes nothing', async () => {
    const { segments, calls } = setup()
    segments.push(tone(59, 16_000, 1000))
    const done = segments.finish()
    calls[0]!.resolve('hello')
    await expect(done).resolves.toBe('hello')
    expect(() => segments.abort()).not.toThrow()
    await expect(done).resolves.toBe('hello')
  })

  it('leaves no rejection unhandled', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const failed = setup({ transcribe: () => Promise.reject(new Error(UNAVAILABLE)) })
      failed.segments.push(tone(61, 16_000, 1000))
      await flush()
      expect(failed.sent()).toHaveLength(2)

      const aborted = setup()
      aborted.segments.push(tone(61, 16_000, 1000))
      aborted.segments.abort()
      aborted.calls[0]!.reject(new Error(UNAVAILABLE))
      await flush()
      await flush()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('the level matches the whole recording', async () => {
    const pcm = varied(130 * SECOND + 1)
    const { segments } = setup({ transcribe: answering() })
    pushIn(segments, pcm, 7_777, 4_001)
    const done = segments.finish()
    const whole = new VoiceLevel()
    whole.add(pcm)
    expect(segments.level()).toEqual(whole.read())
    await done
  })
})

describe('realTimer', () => {
  afterEach(() => { vi.useRealTimers() })

  it('fires after its time, never holds the process open, and can be cleared', () => {
    vi.useFakeTimers()
    const fire = vi.fn()
    const handle = realTimer.set(fire, 120_000) as NodeJS.Timeout
    expect(handle.hasRef()).toBe(false)
    vi.advanceTimersByTime(119_999)
    expect(fire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fire).toHaveBeenCalledOnce()
    realTimer.clear(realTimer.set(fire, 10))
    vi.advanceTimersByTime(10)
    expect(fire).toHaveBeenCalledOnce()
  })
})
