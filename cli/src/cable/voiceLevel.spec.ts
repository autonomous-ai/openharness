import { describe, expect, it } from 'vitest'

import { VoiceLevel } from './voiceLevel.js'

const pcm = (...samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2))
  return b
}

describe('VoiceLevel', () => {
  const level = (...parts: Buffer[]) => {
    const running = new VoiceLevel(16_000)
    for (const part of parts) running.add(part)
    const { peak, rms } = running.read()
    return { peak, rms }
  }

  it('is zero for silence and for no audio at all', () => {
    expect(level(pcm(0, 0, 0))).toEqual({ peak: 0, rms: 0 })
    expect(level(Buffer.alloc(0))).toEqual({ peak: 0, rms: 0 })
    expect(level()).toEqual({ peak: 0, rms: 0 })
  })

  it('reads signed little-endian samples, the loudest negative one included', () => {
    expect(level(pcm(3, -4))).toEqual({ peak: 4, rms: 4 })
    expect(level(pcm(-32768, 0))).toEqual({ peak: 32768, rms: 23170 })
  })

  it('ignores a trailing half sample', () => {
    expect(level(Buffer.concat([pcm(100), Buffer.from([0x7f])]))).toEqual({ peak: 100, rms: 100 })
  })

  it('reads several captures as the one they make together', () => {
    // sqrt((9 + 16 + 10000) / 3) = 57.8
    expect(level(pcm(3, -4), pcm(100))).toEqual({ peak: 100, rms: 58 })
    expect(level(pcm(3, -4, 100))).toEqual({ peak: 100, rms: 58 })
  })
})

// The dial firmware's own voice gate (voice_buffer.c voice_gate_feed): 10 ms blocks, a block loud when its mean |sample|
// is over 600, heard once 320 ms of loud blocks run unbroken.
describe('VoiceLevel heard', () => {
  /** [ms] of alternating ±[amp] at [rate]. */
  const tone = (ms: number, amp: number, rate = 16_000) => {
    const samples = Math.round(ms * rate / 1000)
    return pcm(...Array.from({ length: samples }, (_, i) => i % 2 ? -amp : amp))
  }
  const heard = (rate: number, ...parts: Buffer[]) => {
    const level = new VoiceLevel(rate)
    for (const part of parts) level.add(part)
    return level.read().heard
  }

  it('hears 320 ms of loud blocks, not 310 ms', () => {
    expect(heard(16_000, tone(320, 1000))).toBe(true)
    expect(heard(16_000, tone(310, 1000), tone(500, 0))).toBe(false)
  })

  it('a block is loud only when its mean is over 600', () => {
    expect(heard(16_000, tone(400, 600))).toBe(false)
    expect(heard(16_000, tone(400, 601))).toBe(true)
  })

  it('a quiet block between resets the run', () => {
    expect(heard(16_000, tone(200, 1000), tone(10, 0), tone(200, 1000))).toBe(false)
  })

  it('hears a loud run split across two adds at an odd sample offset', () => {
    const run = tone(330, 1000)
    expect(heard(16_000, run.subarray(0, 2 * 2501), run.subarray(2 * 2501))).toBe(true)
  })

  it('a tap is not heard, however loud', () => {
    expect(heard(16_000, tone(1000, 0), tone(100, 32767), tone(1000, 0))).toBe(false)
  })

  it('once heard, stays heard', () => {
    expect(heard(16_000, tone(320, 1000), tone(2000, 0))).toBe(true)
  })

  it('counts its blocks and run at the recording\'s rate', () => {
    expect(heard(48_000, tone(320, 1000, 48_000))).toBe(true)
    expect(heard(48_000, tone(310, 1000, 48_000))).toBe(false)
  })

  it('hears nothing in no audio', () => {
    expect(heard(16_000)).toBe(false)
  })
})
